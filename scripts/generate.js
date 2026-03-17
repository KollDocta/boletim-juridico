const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");

const parser = new Parser({
  customFields: { item: [["content:encoded", "contentEncoded"]] },
  timeout: 10000,
  headers: { "User-Agent": "BoletimJuridico/1.0" },
  requestOptions: { rejectUnauthorized: false }
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const configPath = path.join(__dirname, "../config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { fontes, verbetes } = config;
const verbetesCompactos = verbetes.join(" | ");
const MAX_ITENS_POR_FONTE = 15;
const MAX_CANDIDATOS = 50;
const TIMEOUT_TOTAL = 25 * 60 * 1000;

function dataTrintaDiasAtras() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

function limparHtml(str = "") {
  return str.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim().slice(0,600);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function coletarFonte(fonte) {
  try {
    console.log("  -> " + fonte.nome + "...");
    const feed = await parser.parseURL(fonte.rss);
    const limite = dataTrintaDiasAtras();
    return feed.items
      .filter((item) => !item.pubDate || new Date(item.pubDate) >= limite)
      .slice(0, MAX_ITENS_POR_FONTE)
      .map((item) => ({
        titulo: item.title || "Sem titulo",
        descricao: limparHtml(item.contentEncoded || item.content || item.summary || ""),
        data: item.pubDate ? new Date(item.pubDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
        url: item.link || "#",
        fonte: fonte.id,
        fonteNome: fonte.nome,
      }));
  } catch (err) {
    console.warn("  AVISO " + fonte.nome + ": " + err.message);
    return [];
  }
}

function prefiltroLocal(itens) {
  const termos = verbetes.map((v) => v.toLowerCase());
  return itens.filter((item) => {
    const texto = (item.titulo + " " + item.descricao).toLowerCase();
    return termos.some((t) => texto.includes(t));
  });
}

async function filtrarComIA(item) {
  await sleep(300);
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: "Filtro juridico. Responda APENAS JSON: {\"relevante\":true/false,\"verbete\":\"NOME ou null\",\"score\":0.0-1.0}\nVerbetes: " + verbetesCompactos,
      messages: [{ role: "user", content: "Titulo: " + item.titulo + "\nTrecho: " + item.descricao.slice(0,300) }],
    });
    const raw = msg.content[0].text.trim().replace(/```json|```/g,"").trim();
    return JSON.parse(raw);
  } catch (err) {
    return { relevante: false, verbete: null, score: 0 };
  }
}

async function gerarSintese(item) {
  await sleep(300);
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: "Advogado especializado em Direito Registral e Notarial. Sintetize em 3 linhas: (1) entendimento juridico, (2) orgao/autor, (3) impacto pratico.",
      messages: [{ role: "user", content: "Fonte: " + item.fonteNome + "\nVerbete: " + item.verbete + "\nTitulo: " + item.titulo + "\nConteudo: " + item.descricao }],
    });
    return msg.content[0].text.trim();
  } catch (err) {
    return item.descricao.slice(0,200) + "...";
  }
}

function agruparPorVerbete(itens) {
  const mapa = new Map();
  for (const item of itens) {
    const v = item.verbete || "Outros";
    if (!mapa.has(v)) mapa.set(v, []);
    mapa.get(v).push({
      titulo: item.titulo,
      fonte: item.fonte,
      fonteNome: item.fonteNome,
      data: item.data,
      url: item.url,
      sintese: item.sintese,
      relevancia: item.relevancia,
    });
  }
  const ordem = new Map(verbetes.map((v, i) => [v, i]));
  return Array.from(mapa.entries())
    .sort(function(a, b) { return (ordem.get(a[0]) || 9999) - (ordem.get(b[0]) || 9999); })
    .map(function(e) { return { tema: e[0], itens: e[1] }; });
}

async function main() {
  const inicio = Date.now();
  console.log("Iniciando Boletim Juridico Semanal...");
  const outputPath = path.join(__dirname, "../data/boletim.json");
  let edicaoAnterior = 0;
  try { edicaoAnterior = JSON.parse(fs.readFileSync(outputPath, "utf8")).edicao || 0; } catch(e) {}

  console.log("\nColetando RSS...");
  let todosItens = [];
  for (const fonte of fontes) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) { console.log("Tempo limite na coleta."); break

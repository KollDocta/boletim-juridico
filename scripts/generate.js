/**
 * generate.js — Boletim Jurídico Semanal
 * Roda via GitHub Actions toda segunda-feira.
 * Lê RSS de STJ, STF, Migalhas e ConJur, filtra por verbetes
 * do Dicionário de Direito Registral e Notarial, e gera sínteses via Claude API.
 */

const fs = require("fs");
const path = require("path");
const Parser = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");

const parser = new Parser({
  customFields: { item: [["content:encoded", "contentEncoded"]] },
  timeout: 15000,
  headers: { "User-Agent": "BoletimJuridico/1.0" },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Config ───────────────────────────────────────────────
const configPath = path.join(__dirname, "../config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { fontes, verbetes } = config;

const verbetesCompactos = verbetes.join(" · ");

// ── Helpers ──────────────────────────────────────────────
function dataSeteDiasAtras() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d;
}

function limparHtml(str = "") {
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 1. Coleta RSS ────────────────────────────────────────
async function coletarFonte(fonte) {
  try {
    console.log(`  -> Buscando ${fonte.nome}...`);
    const feed = await parser.parseURL(fonte.rss);
    const limite = dataSeteDiasAtras();

    return feed.items
      .filter((item) => {
        if (!item.pubDate) return true;
        return new Date(item.pubDate) >= limite;
      })
      .slice(0, 35)
      .map((item) => ({
        titulo: item.title || "Sem título",
        descricao: limparHtml(
          item.contentEncoded || item.content || item.summary || ""
        ),
        data: item.pubDate
          ? new Date(item.pubDate).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0],
        url: item.link || "#",
        fonte: fonte.id,
        fonteNome: fonte.nome,
      }));
  } catch (err) {
    console.warn(`  AVISO: Erro ao buscar ${fonte.nome}: ${err.message}`);
    return [];
  }
}

// ── 2. Pre-filtro local (sem custo de API) ────────────────
// Descarta itens que nao contem nenhuma palavra-chave dos verbetes
function prefiltroLocal(itens) {
  const termos = verbetes.map((v) => v.toLowerCase());
  return itens.filter((item) => {
    const texto = (item.titulo + " " + item.descricao).toLowerCase();
    return termos.some((t) => texto.includes(t));
  });
}

// ── 3. Filtro IA ─────────────────────────────────────────
async function filtrarComIA(item) {
  await sleep(400);
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 150,
      system: `Voce e um filtro especializado em Direito Registral e Notarial.
Analise se o artigo trata de algum dos VERBETES abaixo.

VERBETES:
${verbetesCompactos}

Responda SOMENTE com JSON:
{"relevante": true/false, "verbete": "NOME EXATO DO VERBETE ou null", "score": 0.0-1.0}

Use score >= 0.65 para relevante. Se irrelevante: {"relevante": false, "verbete": null, "score": 0.0}`,
      messages: [
        {
          role: "user",
          content: `Titulo: ${item.titulo}\nTrecho: ${item.descricao}`,
        },
      ],
    });

    const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`    Erro no filtro IA: ${err.message}`);
    return { relevante: false, verbete: null, score: 0 };
  }
}

// ── 4. Geracao de sintese ─────────────────────────────────
async function gerarSintese(item) {
  await sleep(500);
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system: `Voce e um advogado especializado em Direito Registral e Notarial.
Elabore uma sintese tecnica e objetiva em 3-5 linhas, destacando:
1. O principal entendimento ou novidade juridica
2. O orgao, tribunal ou autor
3. O impacto pratico para registradores, notarios ou advogados
Use linguagem precisa, sem jargoes desnecessarios.`,
      messages: [
        {
          role: "user",
          content: `Fonte: ${item.fonteNome}\nVerbete: ${item.verbete}\nTitulo: ${item.titulo}\nConteudo: ${item.descricao}`,
        },
      ],
    });
    return msg.content[0].text.trim();
  } catch (err) {
    console.warn(`    Erro na sintese: ${err.message}`);
    return item.descricao.slice(0, 300) + "...";
  }
}

// ── 5. Agrupamento por verbete ───────────────────────────
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

  // Ordenar pela ordem do dicionario
  const ordemDict = new Map(verbetes.map((v, i) => [v, i]));
  return [...mapa.entries()]
    .sort(([a], [b]) => (ordemDict.get(a) ?? 9999) - (ordemDict.get(b) ?? 9999))
    .map(([verbete, itens]) => ({ tema: verbete, itens }));
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log("Iniciando geracao do Boletim Juridico Semanal...");
  console.log(`${verbetes.length} verbetes carregados do dicionario\n`);

  const outputPath = path.join(__dirname, "../data/boletim.json");
  let edicaoAnterior = 0;
  try {
    edicaoAnterior = JSON.parse(fs.readFileSync(outputPath, "utf8")).edicao || 0;
  } catch (_) {}

  // 1. Coleta
  console.log("Coletando RSS das fontes...");
  let todosItens = [];
  for (const fonte of fontes) {
    const itens = await coletarFonte(fonte);
    todosItens = todosItens.concat(itens);
    console.log(`   ${itens.length} itens de ${fonte.nome}`);
  }
  console.log(`Total: ${todosItens.length} itens\n`);

  // 2. Pre-filtro local
  const candidatos = prefiltroLocal(todosItens);
  console.log(`Pre-filtro: ${candidatos.length} candidatos (${todosItens.length - candidatos.length} descartados sem custo de API)\n`);

  // 3. Filtro IA
  console.log("Filtrando com IA...");
  const relevantes = [];
  for (const item of candidatos) {
    const res = await filtrarComIA(item);
    if (res.relevante && res.score >= 0.65) {
      item.verbete = res.verbete;
      item.relevancia = res.score;
      relevantes.push(item);
      console.log(`  OK [${res.verbete}] ${item.titulo.slice(0, 55)}...`);
    }
  }
  console.log(`\n${relevantes.length} itens relevantes encontrados`);

  if (relevantes.length === 0) {
    console.log("Nenhum item relevante esta semana. Boletim nao atualizado.");
    process.exit(0);
  }

  // 4. Sinteses
  console.log("\nGerando sinteses...");
  for (const item of relevantes) {
    console.log(`  -> ${item.titulo.slice(0, 60)}...`);
    item.sintese = await gerarSintese(item);
  }

  // 5. Agrupamento e salvamento
  const temas = agruparPorVerbete(relevantes);
  const hoje = new Date();
  const boletim = {
    edicao: edicaoAnterior + 1,
    geradoEm: hoje.toISOString(),
    periodo: {
      inicio: dataSeteDiasAtras().toISOString().split("T")[0],
      fim: hoje.toISOString().split("T")[0],
    },
    totalItens: relevantes.length,
    temas,
  };

  fs.writeFileSync(outputPath, JSON.stringify(boletim, null, 2));
  console.log(
    `\nBoletim #${boletim.edicao} salvo — ${boletim.totalItens} itens em ${temas.length} verbetes`
  );
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});

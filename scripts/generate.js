const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const Parser = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const configPath = path.join(__dirname, "../config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { fontes, verbetes } = config;
const verbetesCompactos = verbetes.join(" | ");
const MAX_ITENS_POR_FONTE = 15;
const MAX_CANDIDATOS = 50;
const TIMEOUT_TOTAL = 25 * 60 * 1000;

function normalizarTexto(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 \-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dataTrintaDiasAtras() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

function limparHtml(str) {
  return (str || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function fetchUrl(url) {
  return new Promise(function(resolve, reject) {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: { "User-Agent": "BoletimJuridico/1.0" },
      rejectUnauthorized: false,
      timeout: 10000
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() { resolve(Buffer.concat(chunks).toString("utf8")); });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("Timeout")); });
  });
}

function sanitizarXml(xml) {
  return xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

async function coletarFonte(fonte) {
  try {
    console.log("  -> " + fonte.nome + "...");
    const xmlRaw = await fetchUrl(fonte.rss);
    const xmlClean = sanitizarXml(xmlRaw);
    const parser = new Parser({
      customFields: { item: [["content:encoded", "contentEncoded"]] }
    });
    const feed = await parser.parseString(xmlClean);
    const limite = dataTrintaDiasAtras();
    return feed.items
      .filter(function(item) { return !item.pubDate || new Date(item.pubDate) >= limite; })
      .slice(0, MAX_ITENS_POR_FONTE)
      .map(function(item) {
        return {
          titulo: item.title || "Sem titulo",
          descricao: limparHtml(item.contentEncoded || item.content || item.summary || ""),
          data: item.pubDate ? new Date(item.pubDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
          url: item.link || "#",
          fonte: fonte.id,
          fonteNome: fonte.nome
        };
      });
  } catch (err) {
    console.warn("  AVISO " + fonte.nome + ": " + err.message);
    return [];
  }
}

function prefiltroLocal(itens) {
  const termos = verbetes.map(function(v) { return normalizarTexto(v); });
  return itens.filter(function(item) {
    const texto = normalizarTexto(item.titulo + " " + item.descricao);
    return termos.some(function(t) { return texto.includes(t); });
  });
}

async function filtrarComIA(item) {
  await sleep(300);
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: "Filtro juridico. Responda APENAS JSON: {\"relevante\":true/false,\"verbete\":\"NOME ou null\",\"score\":0.0-1.0}\nVerbetes: " + verbetesCompactos,
      messages: [{ role: "user", content: "Titulo: " + item.titulo + "\nTrecho: " + item.descricao.slice(0, 300) }]
    });
    const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
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
      messages: [{ role: "user", content: "Fonte: " + item.fonteNome + "\nVerbete: " + item.verbete + "\nTitulo: " + item.titulo + "\nConteudo: " + item.descricao }]
    });
    return msg.content[0].text.trim();
  } catch (err) {
    return item.descricao.slice(0, 200) + "...";
  }
}

function agruparPorVerbete(itens) {
  const mapa = new Map();
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    const v = item.verbete || "Outros";
    if (!mapa.has(v)) { mapa.set(v, []); }
    mapa.get(v).push({
      titulo: item.titulo,
      fonte: item.fonte,
      fonteNome: item.fonteNome,
      data: item.data,
      url: item.url,
      sintese: item.sintese,
      relevancia: item.relevancia
    });
  }
  const ordem = new Map(verbetes.map(function(v, i) { return [v, i]; }));
  return Array.from(mapa.entries())
    .sort(function(a, b) {
      const ia = ordem.has(a[0]) ? ordem.get(a[0]) : 9999;
      const ib = ordem.has(b[0]) ? ordem.get(b[0]) : 9999;
      return ia - ib;
    })
    .map(function(e) { return { tema: e[0], itens: e[1] }; });
}

async function main() {
  const inicio = Date.now();
  console.log("Iniciando Boletim Juridico Semanal...");
  const outputPath = path.join(__dirname, "../data/boletim.json");
  let edicaoAnterior = 0;
  try {
    edicaoAnterior = JSON.parse(fs.readFileSync(outputPath, "utf8")).edicao || 0;
  } catch(e) {
    edicaoAnterior = 0;
  }

  console.log("\nColetando RSS...");
  let todosItens = [];
  for (let i = 0; i < fontes.length; i++) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) { console.log("Tempo limite na coleta."); break; }
    const itens = await coletarFonte(fontes[i]);
    todosItens = todosItens.concat(itens);
    console.log("   " + itens.length + " itens de " + fontes[i].nome);
  }
  console.log("Total: " + todosItens.length + " itens");

  const candidatos = prefiltroLocal(todosItens).slice(0, MAX_CANDIDATOS);
  console.log("\nPre-filtro: " + candidatos.length + " candidatos");

  if (candidatos.length === 0) {
    console.log("Nenhum candidato apos pre-filtro. Boletim nao atualizado.");
    process.exit(0);
  }

  console.log("\nFiltrando com IA...");
  const relevantes = [];
  for (let i = 0; i < candidatos.length; i++) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) { console.log("Tempo limite no filtro."); break; }
    const res = await filtrarComIA(candidatos[i]);
    if (res.relevante && res.score >= 0.50) {
      candidatos[i].verbete = res.verbete;
      candidatos[i].relevancia = res.score;
      relevantes.push(candidatos[i]);
      console.log("  OK [" + res.verbete + "] " + candidatos[i].titulo.slice(0, 50));
    }
  }
  console.log("\n" + relevantes.length + " relevantes");

  if (relevantes.length === 0) {
    console.log("Nenhum item relevante. Boletim nao atualizado.");
    process.exit(0);
  }

  console.log("\nGerando sinteses...");
  for (let i = 0; i < relevantes.length; i++) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) { console.log("Tempo limite nas sinteses."); break; }
    relevantes[i].sintese = await gerarSintese(relevantes[i]);
  }

  const temas = agruparPorVerbete(relevantes);
  const hoje = new Date();
  const boletim = {
    edicao: edicaoAnterior + 1,
    geradoEm: hoje.toISOString(),
    periodo: {
      inicio: dataTrintaDiasAtras().toISOString().split("T")[0],
      fim: hoje.toISOString().split("T")[0]
    },
    totalItens: relevantes.length,
    temas: temas
  };

  fs.writeFileSync(outputPath, JSON.stringify(boletim, null, 2));
  console.log("\nBoletim #" + boletim.edicao + " salvo - " + boletim.totalItens + " itens em " + temas.length + " verbetes");
  console.log("Tempo total: " + Math.round((Date.now() - inicio) / 1000) + "s");
}

main().catch(function(err) {
  console.error("Erro fatal:", err);
  process.exit(1);
});

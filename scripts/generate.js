const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const Parser = require("rss-parser");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const configPath = path.join(__dirname, "../config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { verbetes } = config;
const verbetesCompactos = verbetes.join(" | ");
const MAX_CANDIDATOS = 80;
const TIMEOUT_TOTAL = 25 * 60 * 1000;

// ID mais recente conhecido dos provimentos CNJ (atualizar periodicamente)
// Provimento 215/2026 = ID 6753, Provimento 217/2026 ~ ID 6780
const CNJ_ID_MAIS_RECENTE = 6800;
const CNJ_QUANTOS_IDS = 40; // varrer os últimos 40 IDs

const FONTES_RSS = [
  { id: "stj",    nome: "STJ",    url: "https://res.stj.jus.br/hrestp-c-portalp/RSS.xml" },
  { id: "conjur", nome: "ConJur", url: "https://www.conjur.com.br/rss.xml" }
];

const FONTES_HTML = [
  { id: "migalhas1", nome: "Migalhas NR",   url: "https://www.migalhas.com.br/coluna/migalhas-notariais-e-registrais", encoding: "utf8" },
  { id: "migalhas2", nome: "Registralhas",  url: "https://www.migalhas.com.br/coluna/registralhas",                    encoding: "utf8" },
  { id: "cnj",       nome: "CNJ Noticias",  url: "https://www.cnj.jus.br/category/noticias/",                          encoding: "utf8" },
  { id: "tjsp_ext",  nome: "TJSP Extrajud", url: "https://extrajudicial.tjsp.jus.br/pexPtl/consultarComunicadosEmDestaque.do", encoding: "latin1" }
];

function normalizarTexto(str) {
  return (str || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 \-]/g, " ").replace(/\s+/g, " ").trim();
}

function limparMarkdown(str) {
  return (str || "")
    .replace(/#{1,6}\s*/g, "").replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1").replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

function dataTrintaDiasAtras() {
  const d = new Date(); d.setDate(d.getDate() - 30); return d;
}

function limparHtml(str) {
  return (str || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim().slice(0, 500);
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function fetchUrl(url, encoding, timeout) {
  encoding = encoding || "utf8";
  timeout = timeout || 15000;
  return new Promise(function(resolve, reject) {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BoletimJuridico/1.0)", "Accept": "text/html,*/*" },
      rejectUnauthorized: false, timeout: timeout
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, encoding, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode === 403 || res.statusCode === 401 || res.statusCode === 404) {
        reject(new Error("Status code " + res.statusCode)); return;
      }
      const chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        const buf = Buffer.concat(chunks);
        const ct = res.headers["content-type"] || "";
        let enc = encoding;
        if (ct.includes("iso-8859") || ct.includes("latin")) enc = "latin1";
        resolve(buf.toString(enc));
      });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("Timeout")); });
  });
}

function sanitizarXml(xml) {
  return xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/<([^>]*[+;][^>]*)>/g, function(m) { return m.replace(/[+;]/g, "_"); });
}

async function coletarRSS(fonte) {
  try {
    console.log("  -> " + fonte.nome + " (RSS)...");
    const xmlRaw = await fetchUrl(fonte.url);
    const xmlClean = sanitizarXml(xmlRaw);
    const parser = new Parser({ customFields: { item: [["content:encoded", "contentEncoded"]] } });
    const feed = await parser.parseString(xmlClean);
    const limite = dataTrintaDiasAtras();
    return feed.items
      .filter(function(item) { return !item.pubDate || new Date(item.pubDate) >= limite; })
      .slice(0, 15)
      .map(function(item) {
        return {
          titulo: item.title || "Sem titulo",
          descricao: limparHtml(item.contentEncoded || item.content || item.summary || ""),
          data: item.pubDate ? new Date(item.pubDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0],
          url: item.link || "#", fonte: fonte.id, fonteNome: fonte.nome
        };
      });
  } catch (err) { console.warn("  AVISO " + fonte.nome + ": " + err.message); return []; }
}

async function coletarHTML(fonte) {
  try {
    console.log("  -> " + fonte.nome + " (HTML)...");
    const html = await fetchUrl(fonte.url, fonte.encoding || "utf8");
    const encontrados = new Map();
    const hoje = new Date().toISOString().split("T")[0];

    if (fonte.id === "tjsp_ext") {
      const reCom = /Comunicado n[^<]*?(\d+\/\d+)[^<]*<\/[^>]+>\s*(?:<[^>]+>)*\s*([^<]{20,400})/gi;
      const rePub = /Publica[^<]*?(\d+\/\d+)[^<]*<\/[^>]+>\s*(?:<[^>]+>)*\s*([^<]{20,400})/gi;
      const url = "https://extrajudicial.tjsp.jus.br/pexPtl/consultarComunicadosEmDestaque.do";
      let m;
      while ((m = reCom.exec(html)) !== null) {
        const k = m[1];
        if (!encontrados.has(k)) {
          const texto = limparHtml(m[2]).trim();
          encontrados.set(k, { titulo: "Comunicado CGJ nº " + k + " - " + texto.slice(0, 100), descricao: texto, url });
        }
      }
      while ((m = rePub.exec(html)) !== null) {
        const k = "pub-" + m[1];
        if (!encontrados.has(k)) {
          const texto = limparHtml(m[2]).trim();
          encontrados.set(k, { titulo: "Publicação CGJ nº " + m[1] + " - " + texto.slice(0, 100), descricao: texto, url });
        }
      }
      const itens = [];
      for (const [, v] of encontrados) {
        if (itens.length >= 20) break;
        itens.push({ titulo: v.titulo, descricao: v.descricao, data: hoje, url: v.url, fonte: fonte.id, fonteNome: fonte.nome });
      }
      return itens;
    }

    const regexes = [
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>\s*<h[23][^>]*>([^<]{10,200})<\/h[23]>/gi,
      /<h[23][^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{10,200})<\/a>/gi,
      /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*title="([^"]{10,200})"/gi
    ];
    regexes.forEach(function(regex) {
      let m;
      while ((m = regex.exec(html)) !== null) {
        const url = m[1], titulo = limparHtml(m[2]).trim();
        if (titulo.length > 15 && !encontrados.has(url)) encontrados.set(url, titulo);
      }
    });
    if (encontrados.size < 3) {
      const dominios = ["tjsp.jus.br", "cnj.jus.br", "migalhas.com.br", "conjur.com.br"];
      const rx = /href="(https?:\/\/[^"#]+)"[^>]*>([^<]{20,150})</gi;
      let m;
      while ((m = rx.exec(html)) !== null) {
        const url = m[1], titulo = limparHtml(m[2]).trim();
        if (titulo.length > 20 && !encontrados.has(url) &&
            dominios.some(function(d) { return url.includes(d); }) &&
            !url.match(/\.(css|js|png|jpg|gif|svg)$/)) {
          encontrados.set(url, titulo);
        }
      }
    }
    const itens = [];
    let count = 0;
    for (const [url, titulo] of encontrados) {
      if (count >= 15) break;
      itens.push({ titulo, descricao: titulo, data: hoje, url, fonte: fonte.id, fonteNome: fonte.nome });
      count++;
    }
    return itens;
  } catch (err) { console.warn("  AVISO " + fonte.nome + ": " + err.message); return []; }
}

// Coleta provimentos CNJ por ID sequencial
async function coletarProvimentosCNJ() {
  console.log("  -> CNJ Provimentos (IDs sequenciais)...");
  const itens = [];
  const limite = dataTrintaDiasAtras();
  let encontrados = 0;
  let errosConsecutivos = 0;

  for (let id = CNJ_ID_MAIS_RECENTE; id >= CNJ_ID_MAIS_RECENTE - CNJ_QUANTOS_IDS; id--) {
    if (errosConsecutivos >= 5) break; // para se muitos IDs não existirem
    try {
      const url = "https://atos.cnj.jus.br/atos/detalhar/" + id;
      const html = await fetchUrl(url, "utf8", 8000);

      // Extrai título e data do provimento
      const reTitle = /<h1[^>]*>([^<]{10,300})<\/h1>/i;
      const reDate = /(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i;
      const reEmenta = /[Ee]menta[^<]*<\/[^>]+>\s*(?:<[^>]+>)*([^<]{20,500})/;

      const mTitle = reTitle.exec(html);
      const mDate = reDate.exec(html);
      const mEmenta = reEmenta.exec(html);

      if (!mTitle) { errosConsecutivos++; continue; }
      errosConsecutivos = 0;

      const titulo = limparHtml(mTitle[1]).trim();
      if (!titulo || titulo.length < 10) continue;

      // Verifica data se disponível
      if (mDate) {
        const meses = { janeiro:0,fevereiro:1,março:2,abril:3,maio:4,junho:5,julho:6,agosto:7,setembro:8,outubro:9,novembro:10,dezembro:11 };
        const mes = meses[mDate[2].toLowerCase()];
        if (mes !== undefined) {
          const dataAto = new Date(parseInt(mDate[3]), mes, parseInt(mDate[1]));
          if (dataAto < limite) break; // atos mais antigos que 30 dias — para
        }
      }

      const descricao = mEmenta ? limparHtml(mEmenta[1]).trim() : titulo;
      itens.push({
        titulo: titulo,
        descricao: descricao,
        data: new Date().toISOString().split("T")[0],
        url: url,
        fonte: "cnj_atos",
        fonteNome: "CNJ Provimentos"
      });
      encontrados++;
      if (encontrados >= 20) break;
      await sleep(200);
    } catch (err) {
      errosConsecutivos++;
    }
  }
  return itens;
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
      model: "claude-haiku-4-5-20251001", max_tokens: 100,
      system: "Filtro juridico. Responda APENAS JSON: {\"relevante\":true/false,\"verbete\":\"NOME ou null\",\"score\":0.0-1.0}\nVerbetes: " + verbetesCompactos,
      messages: [{ role: "user", content: "Titulo: " + item.titulo + "\nTrecho: " + item.descricao.slice(0, 300) }]
    });
    return JSON.parse(msg.content[0].text.trim().replace(/```json|```/g, "").trim());
  } catch (err) { return { relevante: false, verbete: null, score: 0 }; }
}

async function gerarSintese(item) {
  await sleep(300);
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 150,
      system: "Advogado especializado em Direito Registral e Notarial. Escreva uma sintese CURTA em no maximo 2 linhas, texto corrido, sem markdown. Destaque o ponto juridico central e o impacto pratico.",
      messages: [{ role: "user", content: "Verbete: " + item.verbete + "\nTitulo: " + item.titulo + "\nConteudo: " + item.descricao }]
    });
    return limparMarkdown(msg.content[0].text);
  } catch (err) { return limparMarkdown(item.descricao.slice(0, 150)); }
}

function agruparPorVerbete(itens) {
  const mapa = new Map();
  for (const item of itens) {
    const v = item.verbete || "Outros";
    if (!mapa.has(v)) mapa.set(v, []);
    mapa.get(v).push({ titulo: item.titulo, fonte: item.fonte, fonteNome: item.fonteNome, data: item.data, url: item.url, sintese: item.sintese, relevancia: item.relevancia });
  }
  const ordem = new Map(verbetes.map((v, i) => [v, i]));
  return Array.from(mapa.entries())
    .sort((a, b) => (ordem.get(a[0]) || 9999) - (ordem.get(b[0]) || 9999))
    .map(([tema, itens]) => ({ tema, itens }));
}

async function main() {
  const inicio = Date.now();
  console.log("Iniciando Boletim Juridico Semanal...");
  const outputPath = path.join(__dirname, "../data/boletim.json");
  let edicaoAnterior = 0;
  try { edicaoAnterior = JSON.parse(fs.readFileSync(outputPath, "utf8")).edicao || 0; } catch(e) {}

  let todosItens = [];

  console.log("\nColetando RSS...");
  for (const fonte of FONTES_RSS) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) break;
    const itens = await coletarRSS(fonte);
    todosItens = todosItens.concat(itens);
    console.log("   " + itens.length + " itens de " + fonte.nome);
  }

  console.log("\nColetando HTML...");
  for (const fonte of FONTES_HTML) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) break;
    const itens = await coletarHTML(fonte);
    todosItens = todosItens.concat(itens);
    console.log("   " + itens.length + " itens de " + fonte.nome);
  }

  console.log("\nColetando CNJ Provimentos...");
  if (Date.now() - inicio < TIMEOUT_TOTAL) {
    const provItens = await coletarProvimentosCNJ();
    todosItens = todosItens.concat(provItens);
    console.log("   " + provItens.length + " itens de CNJ Provimentos");
  }

  console.log("\nTotal: " + todosItens.length + " itens");
  const candidatos = prefiltroLocal(todosItens).slice(0, MAX_CANDIDATOS);
  console.log("Pre-filtro: " + candidatos.length + " candidatos");

  if (candidatos.length === 0) { console.log("Nenhum candidato."); process.exit(0); }

  console.log("\nFiltrando com IA...");
  const relevantes = [];
  for (const item of candidatos) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) { console.log("Tempo limite."); break; }
    const res = await filtrarComIA(item);
    if (res.relevante && res.score >= 0.50) {
      item.verbete = res.verbete; item.relevancia = res.score;
      relevantes.push(item);
      console.log("  OK [" + res.verbete + "] " + item.titulo.slice(0, 50));
    }
  }
  console.log("\n" + relevantes.length + " relevantes");
  if (relevantes.length === 0) { console.log("Nenhum relevante."); process.exit(0); }

  console.log("\nGerando sinteses...");
  for (const item of relevantes) {
    if (Date.now() - inicio > TIMEOUT_TOTAL) break;
    item.sintese = await gerarSintese(item);
  }

  const temas = agruparPorVerbete(relevantes);
  const hoje = new Date();
  const boletim = {
    edicao: edicaoAnterior + 1,
    geradoEm: hoje.toISOString(),
    periodo: { inicio: dataTrintaDiasAtras().toISOString().split("T")[0], fim: hoje.toISOString().split("T")[0] },
    totalItens: relevantes.length, temas
  };

  fs.writeFileSync(outputPath, JSON.stringify(boletim, null, 2));
  console.log("\nBoletim #" + boletim.edicao + " salvo - " + boletim.totalItens + " itens em " + temas.length + " verbetes");
  console.log("Tempo total: " + Math.round((Date.now() - inicio) / 1000) + "s");
}

main().catch(function(err) { console.error("Erro fatal:", err); process.exit(1); });

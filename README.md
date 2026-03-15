# 📋 Boletim Jurídico Semanal

Site estático com geração automática de boletim jurídico semanal via IA (Claude).  
Monitora RSS de **STJ, STF, Migalhas e ConJur**, filtra por seus temas e gera sínteses automáticas toda segunda-feira.

---

## 🚀 Como publicar no Netlify (passo a passo)

### 1. Crie uma conta gratuita no GitHub
→ https://github.com/join

### 2. Crie um repositório novo
- Clique em **New repository**
- Nome sugerido: `boletim-juridico`
- Deixe como **Public** (necessário para o Netlify gratuito)
- Clique em **Create repository**

### 3. Suba os arquivos
- Na tela do repositório, clique em **"uploading an existing file"**
- Arraste **todos os arquivos e pastas** deste projeto
- Clique em **Commit changes**

### 4. Conecte ao Netlify
→ https://netlify.com

- Clique em **Add new site → Import an existing project**
- Escolha **GitHub** e autorize
- Selecione o repositório `boletim-juridico`
- Configurações de build: deixe **em branco** (é site estático)
- Clique em **Deploy site**

Seu site já estará no ar! ✅

### 5. Configure a chave da API Claude (para a automação)

A automação semanal precisa de uma chave da API da Anthropic:

1. Acesse https://console.anthropic.com → **API Keys** → crie uma chave
2. No seu repositório GitHub, vá em **Settings → Secrets and variables → Actions**
3. Clique em **New repository secret**
4. Nome: `ANTHROPIC_API_KEY`
5. Valor: cole sua chave da API
6. Clique em **Add secret**

### 6. Ative o GitHub Actions
- Vá em **Actions** no repositório
- Clique em **"I understand my workflows, go ahead and enable them"**

Pronto! Todo **Monday às 8h** (horário de Brasília) o sistema vai:
1. Buscar os RSS das fontes configuradas
2. Filtrar itens relevantes para seus temas
3. Gerar sínteses com IA
4. Atualizar o site automaticamente

---

## ⚙️ Personalizando seus temas

Edite o arquivo `config.json` e altere a lista `"temas"`:

```json
"temas": [
  "Seu tema 1",
  "Seu tema 2",
  "..."
]
```

Você também pode alterar o título, subtítulo e nome da organização na seção `"boletim"`.

---

## 🔄 Gerar um boletim manualmente

No GitHub, vá em **Actions → Gerar Boletim Semanal → Run workflow**.

---

## 📂 Estrutura do projeto

```
index.html              → Site principal
config.json             → Seus temas e configurações
data/
  boletim.json          → Dados atualizados pela automação
scripts/
  generate.js           → Script de coleta + IA
.github/
  workflows/
    weekly.yml          → Agendamento (toda segunda-feira)
package.json            → Dependências Node.js
```

---

## 💡 Dicas

- **Busca**: o site suporta operadores `E`, `OU` e `NÃO`  
  Ex.: `usucapião E extrajudicial NÃO rural`

- **Filtros**: use os botões no topo para filtrar por fonte (STJ, STF, Migalhas, ConJur)

- **Custo estimado**: com 4 fontes e ~20 itens/semana, o custo mensal de API fica em torno de **US$ 2–5**

---

*Gerado com IA — Claude (Anthropic)*

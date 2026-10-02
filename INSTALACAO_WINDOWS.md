# 🚀 Guia de Instalação Rápida — Studio Braid (Windows)

Este guia foi feito para instalar e rodar o **Studio Braid** no computador com Windows com apenas **1 comando** ou **2 cliques**.

---

## ⚡ Passo Rápido (Comando Único)

Abra o **PowerShell** no Windows e execute o comando abaixo (copie e cole):

```powershell
git clone https://github.com/vinilevy/studio-braid.git "$env:USERPROFILE\StudioBraid"; cd "$env:USERPROFILE\StudioBraid"; .\install.bat
```

> **Nota:** Se você já baixou o projeto compactado (ZIP), apenas extraia a pasta, abra-a e dê **dois cliques em `install.bat`**.

---

## 🎯 O que o instalador faz automaticamente por você:

1. **Instala o Node.js LTS** (caso não esteja instalado).
2. **Instala o FFmpeg e FFprobe** (caso não estejam no sistema).
3. **Instala todas as dependências** do Studio Braid (`npm install` na raiz e em `web/`).
4. **Compila o sistema** (`npm run build`).
5. **Cria o ícone na Área de Trabalho** (**Studio Braid**):
   - Ao clicar, ele abre o sistema direto no seu navegador sem abrir nenhuma tela preta ou terminal.
6. **Configura a Inicialização Automática**:
   - Sempre que você ligar ou reiniciar o PC, o Studio Braid iniciará silenciosamente em segundo plano e abrirá na sua tela.

---

## 🖥️ Como usar no dia a dia

- **Para abrir:** Basta dar 2 cliques no ícone **Studio Braid** na sua **Área de Trabalho**.
- **Ao ligar o PC:** O sistema já abre sozinho automaticamente no seu navegador.
- **Endereço local:** [http://127.0.0.1:3847](http://127.0.0.1:3847)

---

## 🛑 Como parar ou reiniciar o sistema

- **Para parar o servidor:** Vá na pasta do projeto e dê dois cliques em `scripts\windows\stop.bat`.
- **Para reiniciar com logs visíveis (modo diagnóstico):** Dê dois cliques em `scripts\windows\start.bat`.

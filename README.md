# Plataforma de Disparo para WhatsApp

Aplicacao full-stack com:

- Conexao do WhatsApp por QR code
- Importacao de planilhas Excel `.xlsx` ou CSV com numeros
- Campo para editar a mensagem
- Disparo em sequencia com acompanhamento do progresso

## Como rodar

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:3001`

Se a porta `3001` ja estiver ocupada, o comando `npm run dev` escolhe outra porta livre automaticamente e aponta o frontend para ela.

## Integracao com Supabase

1. Copie `.env.example` para `.env` e preencha as chaves do projeto.
2. Abra o SQL Editor do Supabase.
3. Execute o arquivo `supabase/schema.sql`.

Depois disso, a plataforma passa a:

- salvar contatos importados
- salvar campanhas disparadas
- registrar o resultado de cada envio
- permitir reaproveitar listas de disparo anteriores direto pela interface

Se o schema ainda nao existir, a plataforma continua funcionando localmente e exibe um aviso de que o banco ainda precisa ser preparado.

## Como gerar build

```bash
npm run build
npm start
```

Nesse modo, o servidor Express entrega o frontend em `client/dist` e tambem responde
as rotas `/api/*` e `/socket.io/*`. O dominio publico precisa apontar para esse
servidor Node, normalmente por um proxy HTTPS/Nginx/Apache para a porta `3001`.

### Front e backend em dominios diferentes

Se o frontend for publicado em um host estatico, como no erro `404` em
`https://disparo.dartsistemas.com/api/health`, publique tambem o backend Node em
outro endereco e aponte o frontend para ele.

Opcao 1: definir a URL antes do build:

```bash
$env:VITE_API_BASE_URL="https://api.seu-dominio.com"
npm run build
```

Opcao 2: editar depois do build o arquivo `client/dist/runtime-config.js`:

```js
window.DISPARO_CONFIG = {
  apiBaseUrl: "https://api.seu-dominio.com",
};
```

O backend precisa manter acessiveis `/api/*` e `/socket.io/*`. As chaves do
Supabase, principalmente `SUPABASE_SERVICE_ROLE_KEY`, devem ficar somente no
ambiente do backend.

## Observacoes

- Os numeros precisam ter DDD. Se a planilha nao tiver codigo do pais, a interface usa `55` por padrao.
- A conexao usa automacao do WhatsApp Web com QR code.
- Use somente com contatos autorizados e respeitando as politicas do WhatsApp.

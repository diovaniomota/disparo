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

## Observacoes

- Os numeros precisam ter DDD. Se a planilha nao tiver codigo do pais, a interface usa `55` por padrao.
- A conexao usa automacao do WhatsApp Web com QR code.
- Use somente com contatos autorizados e respeitando as politicas do WhatsApp.

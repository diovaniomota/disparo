import { startTransition, useEffect, useState } from "react";
import { io } from "socket.io-client";

const normalizeBaseUrl = (value) => String(value ?? "").trim().replace(/\/$/, "");

const runtimeApiBaseUrl =
  window.DISPARO_CONFIG?.apiBaseUrl || window.DISPARO_API_BASE_URL || "";
const apiBaseUrl = normalizeBaseUrl(runtimeApiBaseUrl || import.meta.env.VITE_API_BASE_URL);
const apiDisplayUrl = apiBaseUrl || window.location.origin;
const offlineServerMessage = `Nao foi possivel conectar ao servidor em ${apiDisplayUrl}. Verifique se o backend esta rodando.`;
const missingBackendMessage = `O backend nao respondeu em ${apiDisplayUrl}. Confira se o servidor foi publicado e se a URL da API esta configurada.`;

const socket = io(apiBaseUrl || undefined, {
  autoConnect: false,
});

const initialSessionState = {
  status: "loading",
  qrCode: null,
  phoneNumber: null,
  connectionState: null,
  lastDisconnectReason: null,
  disconnectedByPhone: false,
  lastError: null,
  lastUpdatedAt: null,
};

const initialDispatchState = {
  inProgress: false,
  total: 0,
  processed: 0,
  successCount: 0,
  failedCount: 0,
  items: [],
  startedAt: null,
  finishedAt: null,
};

const initialSupabaseState = {
  configured: false,
  ready: false,
  lastCheckedAt: null,
  message: "Supabase nao configurado.",
};

const initialSavedCampaignsState = {
  items: [],
  loading: false,
  loaded: false,
};

const statusLabels = {
  loading: "Carregando",
  idle: "Desconectado",
  initializing: "Abrindo sessao",
  qr: "Escaneie o QR code",
  authenticated: "Autenticado",
  ready: "Conectado",
  unpaired: "Conexao removida no celular",
  disconnected: "Desconectado",
  auth_failure: "Falha na autenticacao",
  error: "Erro na conexao",
};

const phoneHints = ["telefone", "phone", "celular", "whatsapp", "contato", "numero"];
const nameHints = ["nome", "name", "cliente"];
const notesHints = ["observacao", "obs", "nota", "notes"];

const normalizeDigits = (value, defaultCountryCode = "55") => {
  let digits = String(value ?? "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (defaultCountryCode && digits.length >= 10 && digits.length <= 11) {
    digits = `${defaultCountryCode}${digits}`;
  }

  return digits;
};

const detectPhoneColumn = (rows) => {
  const headerRow = rows[0] ?? [];
  const normalizedHeader = headerRow.map((cell) =>
    String(cell ?? "")
      .trim()
      .toLowerCase(),
  );

  const hintedIndex = normalizedHeader.findIndex((header) =>
    phoneHints.some((hint) => header.includes(hint)),
  );

  if (hintedIndex >= 0) {
    return {
      index: hintedIndex,
      headerDetected: true,
    };
  }

  const sampleRows = rows.slice(0, 6);
  const maxColumns = sampleRows.reduce((largest, row) => Math.max(largest, row.length), 1);
  let winner = {
    index: 0,
    score: -1,
  };

  for (let column = 0; column < maxColumns; column += 1) {
    let score = 0;

    for (const row of sampleRows) {
      const digits = String(row[column] ?? "").replace(/\D/g, "");
      if (digits.length >= 10) {
        score += 1;
      }
    }

    if (score > winner.score) {
      winner = { index: column, score };
    }
  }

  return {
    index: winner.index,
    headerDetected: false,
  };
};

const detectColumnByHints = (headerRow, hints) => {
  const normalizedHeader = headerRow.map((cell) =>
    String(cell ?? "")
      .trim()
      .toLowerCase(),
  );

  return normalizedHeader.findIndex((header) =>
    hints.some((hint) => header.includes(hint)),
  );
};

const extractContacts = (rows, defaultCountryCode) => {
  if (!rows.length) {
    return {
      numbers: [],
      contacts: [],
      columnIndex: 0,
      headerDetected: false,
    };
  }

  const column = detectPhoneColumn(rows);
  const startRow = column.headerDetected ? 1 : 0;
  const headerRow = rows[0] ?? [];
  const nameColumnIndex = column.headerDetected ? detectColumnByHints(headerRow, nameHints) : -1;
  const notesColumnIndex = column.headerDetected ? detectColumnByHints(headerRow, notesHints) : -1;
  const seen = new Set();
  const numbers = [];
  const contacts = [];

  for (const row of rows.slice(startRow)) {
    const normalized = normalizeDigits(row[column.index], defaultCountryCode);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    numbers.push(normalized);
    contacts.push({
      name:
        nameColumnIndex >= 0 && nameColumnIndex !== column.index
          ? String(row[nameColumnIndex] ?? "").trim()
          : "",
      phone: String(row[column.index] ?? "").trim(),
      normalizedPhone: normalized,
      notes:
        notesColumnIndex >= 0 && notesColumnIndex !== column.index
          ? String(row[notesColumnIndex] ?? "").trim()
          : "",
    });
  }

  return {
    numbers,
    contacts,
    columnIndex: column.index,
    headerDetected: column.headerDetected,
  };
};

const formatDateTime = (value) => {
  if (!value) {
    return "Agora";
  }

  return new Date(value).toLocaleString("pt-BR");
};

const loadSpreadsheetRows = async (file) => {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".csv")) {
    const { default: Papa } = await import("papaparse");

    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        skipEmptyLines: true,
        complete: ({ data }) => resolve(data),
        error: () => reject(new Error("Nao foi possivel ler o arquivo CSV.")),
      });
    });
  }

  if (lowerName.endsWith(".xlsx")) {
    const { default: readXlsxFile } = await import("read-excel-file");
    return readXlsxFile(file);
  }

  throw new Error("Formato nao suportado. Use um arquivo .xlsx ou .csv.");
};

const toUserErrorMessage = (error, fallback = "Nao foi possivel concluir a operacao.") => {
  if (error instanceof Error) {
    if (error.message === "Failed to fetch") {
      return offlineServerMessage;
    }

    return error.message || fallback;
  }

  return fallback;
};

const request = async (path, options = {}) => {
  let response;

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    });
  } catch {
    throw new Error(offlineServerMessage);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));

    if (response.status === 404 && path.startsWith("/api/")) {
      throw new Error(data.message || missingBackendMessage);
    }

    throw new Error(data.message || "Nao foi possivel concluir a operacao.");
  }

  return response.json();
};

export default function App() {
  const [session, setSession] = useState(initialSessionState);
  const [dispatchState, setDispatchState] = useState(initialDispatchState);
  const [supabaseState, setSupabaseState] = useState(initialSupabaseState);
  const [savedCampaigns, setSavedCampaigns] = useState(initialSavedCampaignsState);
  const [message, setMessage] = useState(
    "Ola! Esta e uma mensagem enviada pela plataforma. Se precisar responder, fique a vontade.",
  );
  const [countryCode, setCountryCode] = useState("55");
  const [intervalMs, setIntervalMs] = useState(2500);
  const [contacts, setContacts] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [sheetMeta, setSheetMeta] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const loadSavedCampaigns = async ({ force = false } = {}) => {
    if (!supabaseState.ready && !force) {
      return;
    }

    setSavedCampaigns((current) => ({
      ...current,
      loading: true,
    }));

    try {
      const result = await request("/api/campaigns?limit=6");
      setSavedCampaigns({
        items: result.campaigns ?? [],
        loading: false,
        loaded: true,
      });
    } catch {
      setSavedCampaigns((current) => ({
        ...current,
        loading: false,
        loaded: current.loaded,
      }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    let retryId = null;

    const syncSession = (data) => {
      setErrorMessage("");
      setSession(data);
    };

    const syncDispatch = (data) => {
      setErrorMessage("");
      setDispatchState(data);
    };

    socket.on("session-state", syncSession);
    socket.on("dispatch-state", syncDispatch);
    socket.on("connect", () => {
      setErrorMessage("");
    });

    const loadHealth = async () => {
      try {
        const data = await request("/api/health");

        if (cancelled) {
          return;
        }

        setSession(data.session);
        setDispatchState(data.dispatch);
        setSupabaseState(data.supabase ?? initialSupabaseState);
        setErrorMessage("");

        if (data.supabase?.ready) {
          setSavedCampaigns((current) => ({
            ...current,
            loaded: current.loaded,
          }));
        }

        if (!socket.connected) {
          socket.connect();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setErrorMessage(toUserErrorMessage(error));
        retryId = window.setTimeout(loadHealth, 2000);
      }
    };

    loadHealth();

    return () => {
      cancelled = true;
      if (retryId) {
        window.clearTimeout(retryId);
      }
      socket.off("session-state", syncSession);
      socket.off("dispatch-state", syncDispatch);
      socket.off("connect");
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (supabaseState.ready && !savedCampaigns.loaded && !savedCampaigns.loading) {
      loadSavedCampaigns({ force: true });
    }
  }, [savedCampaigns.loaded, savedCampaigns.loading, supabaseState.ready]);

  const handleStartSession = async () => {
    setBusyAction("session");
    setErrorMessage("");
    setFeedback("");

    try {
      await request("/api/session/start", {
        method: "POST",
      });
      setFeedback("Sessao iniciada. Escaneie o QR code assim que ele aparecer.");
    } catch (error) {
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleLogout = async () => {
    setBusyAction("logout");
    setErrorMessage("");
    setFeedback("");

    try {
      await request("/api/session/logout", {
        method: "POST",
      });
      setFeedback("Sessao desconectada com sucesso.");
    } catch (error) {
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleSpreadsheetImport = async (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setErrorMessage("");
    setFeedback("");

    try {
      const rows = await loadSpreadsheetRows(file);
      const extracted = extractContacts(rows, countryCode);
      const importResult = await request("/api/contacts/import", {
        method: "POST",
        body: JSON.stringify({
          contacts: extracted.contacts,
          sourceFileName: file.name,
        }),
      }).catch(() => null);

      startTransition(() => {
        setContacts(extracted.contacts);
        setNumbers(extracted.numbers);
        setSheetMeta({
          fileName: file.name,
          totalRows: rows.length,
          extractedCount: extracted.numbers.length,
          columnIndex: extracted.columnIndex,
          headerDetected: extracted.headerDetected,
        });
      });

      if (importResult?.enabled) {
        setFeedback(
          `${extracted.numbers.length} numeros foram carregados da planilha e ${importResult.savedCount} contatos foram salvos no Supabase.`,
        );
      } else if (importResult?.message) {
        setFeedback(
          `${extracted.numbers.length} numeros foram carregados da planilha. ${importResult.message}`,
        );
      } else {
        setFeedback(`${extracted.numbers.length} numeros foram carregados da planilha.`);
      }
    } catch (error) {
      setErrorMessage("Nao foi possivel ler a planilha. Verifique se o arquivo e valido.");
    } finally {
      event.target.value = "";
    }
  };

  const handleSendMessages = async () => {
    setBusyAction("dispatch");
    setErrorMessage("");
    setFeedback("");

    try {
      const result = await request("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          numbers,
          contacts,
          sourceFileName: sheetMeta?.fileName ?? null,
          message,
          defaultCountryCode: countryCode,
          intervalMs,
        }),
      });

      setFeedback(
        `Disparo concluido: ${result.successCount} enviados e ${result.failedCount} falhas.`,
      );

      if (supabaseState.ready) {
        loadSavedCampaigns({ force: true });
      }
    } catch (error) {
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleReuseCampaignList = async (campaignId) => {
    setBusyAction(`reuse-${campaignId}`);
    setErrorMessage("");
    setFeedback("");

    try {
      const result = await request(`/api/campaigns/${campaignId}/recipients`);
      const reusedContacts = result.recipients ?? [];
      const reusedNumbers = reusedContacts.map((contact) => contact.normalizedPhone);

      startTransition(() => {
        setContacts(reusedContacts);
        setNumbers(reusedNumbers);
        setSheetMeta({
          fileName: result.campaign?.sourceFileName || "Lista salva no Supabase",
          totalRows: reusedContacts.length,
          extractedCount: reusedContacts.length,
          columnIndex: 0,
          headerDetected: false,
        });
      });

      setFeedback(
        `${reusedContacts.length} contatos foram carregados de uma lista salva no Supabase.`,
      );
    } catch (error) {
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  };

  const progress = dispatchState.total
    ? Math.round((dispatchState.processed / dispatchState.total) * 100)
    : 0;
  const isConnected = session.status === "ready";
  const shouldShowReconnectCopy = session.status === "unpaired" || session.disconnectedByPhone;
  const canSend = isConnected && numbers.length > 0 && message.trim() && !dispatchState.inProgress;
  const supabaseBadgeLabel = !supabaseState.configured
    ? "Supabase nao configurado"
    : supabaseState.ready
      ? "Supabase conectado"
      : "Supabase aguardando schema";

  return (
    <main className="page-shell">
      <div className="background-orb background-orb--left" />
      <div className="background-orb background-orb--right" />

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Plataforma React + WhatsApp Web</span>
          <h1>Conecte por QR code, importe sua lista e dispare mensagens em poucos passos.</h1>
          <p>
            A tela centraliza toda a operacao: autenticar o WhatsApp, carregar os
            contatos do Excel e acompanhar o envio em tempo real.
          </p>
        </div>

        <div className="status-panel">
          <div className="status-header">
            <span className={`status-dot status-dot--${session.status}`} />
            <div>
              <strong>{statusLabels[session.status] || "Status desconhecido"}</strong>
              <p>
                {session.phoneNumber
                  ? `Conta conectada: ${session.phoneNumber}`
                  : shouldShowReconnectCopy
                    ? "A conexao foi removida no celular. Gere um novo QR code para reconectar."
                    : "Nenhuma conta conectada no momento."}
              </p>
            </div>
          </div>

          <div className="status-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={handleStartSession}
              disabled={busyAction === "session" || dispatchState.inProgress}
            >
              {busyAction === "session"
                ? "Abrindo..."
                : shouldShowReconnectCopy
                  ? "Gerar novo QR code"
                  : "Gerar QR code"}
            </button>

            <button
              type="button"
              className="button button--ghost"
              onClick={handleLogout}
              disabled={busyAction === "logout" || dispatchState.inProgress}
            >
              {busyAction === "logout" ? "Saindo..." : "Desconectar"}
            </button>
          </div>

          <p className="status-hint">
            <strong>{supabaseBadgeLabel}</strong>
            {supabaseState.message ? ` ${supabaseState.message}` : ""}
          </p>
          {session.lastError && <p className="status-error">{session.lastError}</p>}
          {session.connectionState && (
            <small>Estado atual do WhatsApp Web: {session.connectionState}</small>
          )}
          <small>Ultima atualizacao: {formatDateTime(session.lastUpdatedAt)}</small>
        </div>
      </section>

      {(feedback || errorMessage) && (
        <section className="feedback-strip">
          {feedback && <p className="feedback feedback--success">{feedback}</p>}
          {errorMessage && <p className="feedback feedback--error">{errorMessage}</p>}
        </section>
      )}

      <section className="dashboard-grid">
        <article className="panel panel--qr">
          <div className="panel-heading">
            <span className="panel-kicker">1. Conexao</span>
            <h2>QR code do WhatsApp</h2>
          </div>

          {session.qrCode ? (
            <div className="qr-wrapper">
              <img src={session.qrCode} alt="QR code para conectar o WhatsApp" />
            </div>
          ) : (
            <div className="empty-state">
              <strong>
                {isConnected
                  ? "WhatsApp conectado e pronto para enviar."
                  : shouldShowReconnectCopy
                    ? "A sessao foi removida no celular. Gere um novo QR code para voltar a conectar."
                  : "Clique em gerar QR code para iniciar a autenticacao."}
              </strong>
              <p>
                Se a sessao ja existir, o backend tenta restaurar a conexao automaticamente.
              </p>
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <span className="panel-kicker">2. Lista de contatos</span>
            <h2>Importe seu Excel</h2>
          </div>

          <label className="file-dropzone">
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={handleSpreadsheetImport}
            />
            <span>Selecionar planilha</span>
            <small>Arquivos `.xlsx` ou `.csv`</small>
          </label>

          <div className="inline-fields">
            <label>
              Codigo do pais
              <input
                type="text"
                value={countryCode}
                onChange={(event) => setCountryCode(event.target.value.replace(/\D/g, ""))}
                placeholder="55"
              />
            </label>

            <label>
              Intervalo entre envios
              <input
                type="number"
                min="500"
                max="10000"
                step="100"
                value={intervalMs}
                onChange={(event) => setIntervalMs(Number(event.target.value || 0))}
              />
            </label>
          </div>

          <div className="metrics">
            <div>
              <strong>{numbers.length}</strong>
              <span>contatos validos</span>
            </div>
            <div>
              <strong>{sheetMeta?.fileName || "Nenhuma planilha"}</strong>
              <span>arquivo selecionado</span>
            </div>
            <div>
              <strong>{sheetMeta ? `Coluna ${sheetMeta.columnIndex + 1}` : "--"}</strong>
              <span>origem detectada</span>
            </div>
          </div>

          <div className="contact-preview">
            {numbers.length > 0 ? (
              <>
                {numbers.slice(0, 12).map((number) => (
                  <span key={number} className="contact-chip">
                    {number}
                  </span>
                ))}
                {numbers.length > 12 && (
                  <span className="contact-chip contact-chip--more">
                    +{numbers.length - 12} contatos
                  </span>
                )}
              </>
            ) : (
              <p>Nenhum numero carregado ainda.</p>
            )}
          </div>

          <div className="saved-campaigns">
            <div className="saved-campaigns__header">
              <div>
                <strong>Listas salvas</strong>
                <p>Reaproveite uma lista de disparo anterior salva no Supabase.</p>
              </div>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => loadSavedCampaigns({ force: true })}
                disabled={!supabaseState.ready || savedCampaigns.loading}
              >
                {savedCampaigns.loading ? "Atualizando..." : "Atualizar"}
              </button>
            </div>

            {supabaseState.ready ? (
              savedCampaigns.items.length > 0 ? (
                <div className="saved-campaigns__list">
                  {savedCampaigns.items.map((campaign) => (
                    <div key={campaign.id} className="saved-campaign">
                      <div>
                        <strong>
                          {campaign.sourceFileName || "Campanha sem arquivo"}
                        </strong>
                        <p>
                          {campaign.totalContacts} contatos · {formatDateTime(campaign.createdAt)}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() => handleReuseCampaignList(campaign.id)}
                        disabled={busyAction === `reuse-${campaign.id}`}
                      >
                        {busyAction === `reuse-${campaign.id}`
                          ? "Carregando..."
                          : "Usar lista"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="saved-campaigns__empty">
                  Nenhuma lista salva ainda. Depois do primeiro disparo, ela aparece aqui.
                </p>
              )
            ) : (
              <p className="saved-campaigns__empty">
                O Supabase precisa estar pronto para salvar e reutilizar listas.
              </p>
            )}
          </div>
        </article>

        <article className="panel panel--wide">
          <div className="panel-heading">
            <span className="panel-kicker">3. Mensagem</span>
            <h2>Escreva o texto que sera enviado</h2>
          </div>

          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Digite aqui a mensagem da campanha..."
            rows={8}
          />

          <div className="composer-footer">
            <small>
              {message.trim().length} caracteres. Mantenha o conteudo relevante e envie apenas
              para contatos autorizados.
            </small>

            <button
              type="button"
              className="button button--accent"
              onClick={handleSendMessages}
              disabled={!canSend || busyAction === "dispatch"}
            >
              {busyAction === "dispatch" || dispatchState.inProgress
                ? "Enviando..."
                : "Iniciar disparo"}
            </button>
          </div>
        </article>

        <article className="panel panel--wide">
          <div className="panel-heading">
            <span className="panel-kicker">4. Acompanhamento</span>
            <h2>Progresso do envio</h2>
          </div>

          <div className="progress-card">
            <div className="progress-topline">
              <strong>
                {dispatchState.inProgress ? "Disparo em andamento" : "Nenhum disparo ativo"}
              </strong>
              <span>{progress}%</span>
            </div>
            <div className="progress-bar">
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="progress-stats">
              <span>Total: {dispatchState.total}</span>
              <span>Processados: {dispatchState.processed}</span>
              <span>Enviados: {dispatchState.successCount}</span>
              <span>Falhas: {dispatchState.failedCount}</span>
            </div>
          </div>

          <div className="results-list">
            {dispatchState.items.length > 0 ? (
              dispatchState.items
                .slice()
                .reverse()
                .slice(0, 12)
                .map((item) => (
                  <div key={`${item.number}-${item.sentAt}`} className="result-row">
                    <div>
                      <strong>{item.number}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <span className={`result-badge result-badge--${item.status}`}>
                      {item.status === "sent" ? "Enviado" : "Falhou"}
                    </span>
                  </div>
                ))
            ) : (
              <p className="results-empty">Os resultados do disparo aparecem aqui em tempo real.</p>
            )}
          </div>
        </article>
      </section>
    </main>
  );
}

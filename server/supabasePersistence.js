import { createClient } from "@supabase/supabase-js";

const defaultStatus = {
  configured: false,
  ready: false,
  lastCheckedAt: null,
  message: "Supabase nao configurado.",
};

const normalizePhone = (value) => String(value ?? "").replace(/\D/g, "");

export function createSupabasePersistence() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const configured = Boolean(supabaseUrl && serviceRoleKey);
  const client = configured
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

  let cachedStatus = { ...defaultStatus };
  let lastCheckTime = 0;
  let schemaWarningLogged = false;

  const setStatus = (patch) => {
    cachedStatus = {
      ...cachedStatus,
      ...patch,
      configured,
      lastCheckedAt: new Date().toISOString(),
    };

    return cachedStatus;
  };

  const getNotReadyResult = async () => {
    const status = await getStatus();
    return {
      enabled: false,
      message: status.message,
    };
  };

  const upsertContactsIntoDatabase = async (
    supabase,
    { contacts, importId = null },
  ) => {
    const rows = contacts.map((contact) => ({
      import_id: importId,
      name: contact.name || null,
      phone: contact.phone || contact.normalizedPhone,
      normalized_phone: normalizePhone(contact.normalizedPhone || contact.phone),
      notes: contact.notes || null,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("contacts")
      .upsert(rows, {
        onConflict: "normalized_phone",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) {
      throw error;
    }

    return {
      savedCount: data?.length ?? rows.length,
    };
  };

  async function getStatus({ force = false } = {}) {
    if (!configured || !client) {
      return {
        ...defaultStatus,
        configured: false,
      };
    }

    if (!force && Date.now() - lastCheckTime < 15000 && cachedStatus.lastCheckedAt) {
      return cachedStatus;
    }

    lastCheckTime = Date.now();

    try {
      const { error } = await client.from("campaigns").select("id").limit(1);

      if (error) {
        throw error;
      }

      schemaWarningLogged = false;

      return setStatus({
        ready: true,
        message: "Supabase conectado e pronto para persistir campanhas e contatos.",
      });
    } catch (error) {
      if (!schemaWarningLogged) {
        console.error("[supabase] Schema indisponivel:", error.message);
        schemaWarningLogged = true;
      }

      return setStatus({
        ready: false,
        message:
          "Supabase configurado, mas o schema ainda nao foi criado. Execute o arquivo supabase/schema.sql no SQL Editor do projeto.",
      });
    }
  }

  const runIfReady = async (taskName, task) => {
    const status = await getStatus();

    if (!status.ready || !client) {
      return {
        enabled: false,
        message: status.message,
      };
    }

    try {
      return await task(client);
    } catch (error) {
      console.error(`[supabase] Falha em ${taskName}:`, error.message);
      await getStatus({ force: true });

      return {
        enabled: false,
        message: error.message,
      };
    }
  };

  const saveContacts = async ({
    contacts,
    sourceFileName = null,
    createImportRecord = false,
  }) => {
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return {
        enabled: false,
        savedCount: 0,
        message: "Nenhum contato valido para salvar.",
      };
    }

    return runIfReady("saveContacts", async (supabase) => {
      let importId = null;

      if (createImportRecord) {
        const { data: importBatch, error: importError } = await supabase
          .from("contact_imports")
          .insert({
            source_filename: sourceFileName,
            imported_count: contacts.length,
          })
          .select("id")
          .single();

        if (importError) {
          throw importError;
        }

        importId = importBatch.id;
      }

      const result = await upsertContactsIntoDatabase(supabase, {
        contacts,
        importId,
      });

      return {
        enabled: true,
        savedCount: result.savedCount,
        importId,
        message: "Contatos salvos no Supabase.",
      };
    });
  };

  const importContacts = (payload) =>
    saveContacts({
      ...payload,
      createImportRecord: true,
    });

  const ensureContacts = (payload) =>
    saveContacts({
      ...payload,
      createImportRecord: false,
    });

  const createCampaign = async ({
    message,
    intervalMs,
    totalContacts,
    sourceFileName = null,
    sessionPhoneNumber = null,
  }) =>
    runIfReady("createCampaign", async (supabase) => {
      const { data, error } = await supabase
        .from("campaigns")
        .insert({
          message,
          interval_ms: intervalMs,
          total_contacts: totalContacts,
          processed_contacts: 0,
          success_count: 0,
          failed_count: 0,
          status: "running",
          source_filename: sourceFileName,
          session_phone_number: sessionPhoneNumber,
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (error) {
        throw error;
      }

      return {
        enabled: true,
        campaignId: data.id,
      };
    });

  const recordCampaignMessage = async ({
    campaignId,
    phone,
    status,
    detail,
    sentAt,
  }) => {
    if (!campaignId) {
      return getNotReadyResult();
    }

    return runIfReady("recordCampaignMessage", async (supabase) => {
      const normalizedPhone = normalizePhone(phone);
      let contactId = null;

      const { data: contact } = await supabase
        .from("contacts")
        .select("id")
        .eq("normalized_phone", normalizedPhone)
        .maybeSingle();

      contactId = contact?.id ?? null;

      const { error } = await supabase.from("campaign_messages").insert({
        campaign_id: campaignId,
        contact_id: contactId,
        phone,
        normalized_phone: normalizedPhone,
        status,
        detail,
        sent_at: sentAt,
      });

      if (error) {
        throw error;
      }

      return {
        enabled: true,
      };
    });
  };

  const updateCampaignProgress = async ({
    campaignId,
    processedContacts,
    successCount,
    failedCount,
  }) => {
    if (!campaignId) {
      return getNotReadyResult();
    }

    return runIfReady("updateCampaignProgress", async (supabase) => {
      const { error } = await supabase
        .from("campaigns")
        .update({
          processed_contacts: processedContacts,
          success_count: successCount,
          failed_count: failedCount,
        })
        .eq("id", campaignId);

      if (error) {
        throw error;
      }

      return {
        enabled: true,
      };
    });
  };

  const finishCampaign = async ({
    campaignId,
    processedContacts,
    successCount,
    failedCount,
  }) => {
    if (!campaignId) {
      return getNotReadyResult();
    }

    return runIfReady("finishCampaign", async (supabase) => {
      const { error } = await supabase
        .from("campaigns")
        .update({
          processed_contacts: processedContacts,
          success_count: successCount,
          failed_count: failedCount,
          status: failedCount > 0 ? "completed_with_failures" : "completed",
          finished_at: new Date().toISOString(),
        })
        .eq("id", campaignId);

      if (error) {
        throw error;
      }

      return {
        enabled: true,
      };
    });
  };

  const listCampaigns = async ({ limit = 8 } = {}) =>
    runIfReady("listCampaigns", async (supabase) => {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 30));
      const { data, error } = await supabase
        .from("campaigns")
        .select(
          "id, source_filename, message, total_contacts, processed_contacts, success_count, failed_count, status, created_at, started_at, finished_at",
        )
        .order("created_at", { ascending: false })
        .limit(safeLimit);

      if (error) {
        throw error;
      }

      return {
        enabled: true,
        campaigns: (data ?? []).map((campaign) => ({
          id: campaign.id,
          sourceFileName: campaign.source_filename,
          message: campaign.message,
          totalContacts: campaign.total_contacts,
          processedContacts: campaign.processed_contacts,
          successCount: campaign.success_count,
          failedCount: campaign.failed_count,
          status: campaign.status,
          createdAt: campaign.created_at,
          startedAt: campaign.started_at,
          finishedAt: campaign.finished_at,
        })),
      };
    });

  const getCampaignRecipients = async (campaignId) => {
    if (!campaignId) {
      return {
        enabled: false,
        recipients: [],
        message: "Campanha invalida.",
      };
    }

    return runIfReady("getCampaignRecipients", async (supabase) => {
      const { data: campaign, error: campaignError } = await supabase
        .from("campaigns")
        .select("id, source_filename, message, total_contacts, created_at")
        .eq("id", campaignId)
        .single();

      if (campaignError) {
        throw campaignError;
      }

      const { data, error } = await supabase
        .from("campaign_messages")
        .select("phone, normalized_phone")
        .eq("campaign_id", campaignId)
        .order("sent_at", { ascending: true });

      if (error) {
        throw error;
      }

      const seen = new Set();
      const recipients = [];

      for (const item of data ?? []) {
        const normalizedPhone = normalizePhone(item.normalized_phone || item.phone);

        if (!normalizedPhone || seen.has(normalizedPhone)) {
          continue;
        }

        seen.add(normalizedPhone);
        recipients.push({
          name: "",
          phone: item.phone,
          normalizedPhone,
          notes: "",
        });
      }

      return {
        enabled: true,
        campaign: {
          id: campaign.id,
          sourceFileName: campaign.source_filename,
          message: campaign.message,
          totalContacts: campaign.total_contacts,
          createdAt: campaign.created_at,
        },
        recipients,
      };
    });
  };

  return {
    getStatus,
    saveContacts,
    importContacts,
    ensureContacts,
    createCampaign,
    recordCampaignMessage,
    updateCampaignProgress,
    finishCampaign,
    listCampaigns,
    getCampaignRecipients,
  };
}

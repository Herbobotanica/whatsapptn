// ============================================================
// Herbo Botánica — Sincronización automática de órdenes enviadas
// Corre cada 10 minutos.
// Flujo: Tienda Nube (órdenes "enviadas") → Freshworks CRM (contacto → lista) → Journey WhatsApp
// ============================================================

const TN_BASE = `https://api.tiendanube.com/v1/${process.env.TN_STORE_ID}`;
const FW_BASE = 'https://herbobotanica.myfreshworks.com/crm/sales/api';
const LIST_ID = 27000020581; // Lista "Notificar Envio"

export default async function handler(req, res) {
  // Seguridad: solo aceptar llamadas con el CRON_SECRET correcto
  const secret = req.query.secret;

  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const missingVars = [];

    if (!process.env.TN_STORE_ID) missingVars.push('TN_STORE_ID');
    if (!process.env.TN_ACCESS_TOKEN) missingVars.push('TN_ACCESS_TOKEN');
    if (!process.env.FRESHWORKS_API_KEY) missingVars.push('FRESHWORKS_API_KEY');
    if (!process.env.CRON_SECRET) missingVars.push('CRON_SECRET');

    if (missingVars.length > 0) {
      return res.status(500).json({
        error: 'Faltan variables de entorno',
        missingVars
      });
    }

    // ── 1. Traer órdenes enviadas en los últimos 30 minutos ──────────────
    const desde = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    // En las pruebas, Tienda Nube devolvió órdenes enviadas con "fulfilled".
    const tnUrl =
      `${TN_BASE}/orders?shipping_status=fulfilled` +
      `&updated_at_min=${encodeURIComponent(desde)}` +
      `&per_page=50`;

    console.log('Consultando Tienda Nube:', tnUrl);

    const tnRes = await fetch(tnUrl, {
      headers: {
        Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
        'User-Agent': 'HerboBotanica (santacolomaeugenia@gmail.com)',
        'Content-Type': 'application/json'
      }
    });

    const tnText = await tnRes.text();

    if (!tnRes.ok) {
      const tnError = safeJson(tnText);

      // Tienda Nube puede devolver 404 "Last page is 0" cuando no hay resultados.
      // Para nuestro flujo eso no es un error: significa que no hay órdenes nuevas.
      if (
        tnRes.status === 404 &&
        tnError?.description === 'Last page is 0'
      ) {
        console.log('Sin órdenes nuevas enviadas. Tienda Nube devolvió Last page is 0.');

        return res.status(200).json({
          processed: 0,
          errors: [],
          detail: 'Sin órdenes nuevas enviadas'
        });
      }

      console.error('Error Tienda Nube:', tnText);

      return res.status(500).json({
        error: 'Error al consultar Tienda Nube',
        status: tnRes.status,
        detail: tnError
      });
    }

    const orders = safeJson(tnText);

    if (!Array.isArray(orders) || orders.length === 0) {
      console.log('Sin órdenes nuevas enviadas.');

      return res.status(200).json({
        processed: 0,
        errors: []
      });
    }

    console.log(`Órdenes a procesar: ${orders.length}`);

    let processed = 0;
    const errors = [];

    for (const order of orders) {
      const customer = order.customer;

      // Saltear si no tiene teléfono ni email
      if (!customer?.phone && !customer?.email) {
        console.log(`Orden #${order.number} sin teléfono ni email, se saltea.`);

        errors.push({
          order: order.number,
          stage: 'validation',
          error: 'Orden sin teléfono ni email'
        });

        continue;
      }

      const email = customer.email || '';
      const phone = customer.phone?.replace(/\D/g, '') || '';

      try {
        // ── 2. Buscar si el contacto ya existe en Freshworks CRM ─────────
        // /contacts/search devolvía 404. El endpoint correcto probado es /lookup.
        let existingContactId = null;

        if (email) {
          existingContactId = await findFreshworksContactIdByEmail(email);
        }

        if (existingContactId) {
          // ── 3a. Contacto existe → agregar a la lista ─────────────────
          const updateResult = await updateFreshworksContactList(existingContactId);

          if (!updateResult.ok) {
            console.error(
              `Error actualizando contacto orden #${order.number}:`,
              updateResult.text
            );

            errors.push({
              order: order.number,
              stage: 'freshworks_update_existing',
              contactId: existingContactId,
              status: updateResult.status,
              error: safeJson(updateResult.text)
            });

            continue;
          }

          console.log(
            `✓ (actualizado) Orden #${order.number} — ${customer.first_name || ''} ${customer.last_name || ''}`
          );

          processed++;
          continue;
        }

        // ── 3b. Contacto nuevo → crear y agregar a la lista ─────────────
        const createRes = await fetch(`${FW_BASE}/contacts`, {
          method: 'POST',
          headers: freshworksHeaders(),
          body: JSON.stringify({
            contact: {
              first_name: customer.first_name || '',
              last_name: customer.last_name || '',
              mobile_number: phone,
              email,
              contact_list_ids: [LIST_ID]
            }
          })
        });

        const createText = await createRes.text();
        const createData = safeJson(createText);

        if (!createRes.ok) {
          // Si Freshworks dice que ya existe, intentamos buscarlo por email y actualizarlo.
          const duplicateByText = isDuplicateContactError(createData);

          if (duplicateByText && email) {
            const retryContactId = await findFreshworksContactIdByEmail(email);

            if (retryContactId) {
              const updateResult = await updateFreshworksContactList(retryContactId);

              if (!updateResult.ok) {
                console.error(
                  `Error actualizando contacto duplicado orden #${order.number}:`,
                  updateResult.text
                );

                errors.push({
                  order: order.number,
                  stage: 'freshworks_update_after_duplicate_lookup',
                  contactId: retryContactId,
                  status: updateResult.status,
                  error: safeJson(updateResult.text)
                });

                continue;
              }

              console.log(
                `✓ (actualizado duplicado) Orden #${order.number} — ${customer.first_name || ''} ${customer.last_name || ''}`
              );

              processed++;
              continue;
            }
          }

          console.error(`Error creando contacto orden #${order.number}:`, createText);

          errors.push({
            order: order.number,
            stage: 'freshworks_create',
            status: createRes.status,
            error: createData
          });

          continue;
        }

        console.log(
          `✓ (creado) Orden #${order.number} — ${customer.first_name || ''} ${customer.last_name || ''}`
        );

        processed++;
      } catch (innerErr) {
        console.error(`Error procesando orden #${order.number}:`, innerErr.message);

        errors.push({
          order: order.number,
          stage: 'order_processing',
          error: innerErr.message
        });
      }
    }

    return res.status(200).json({
      processed,
      errors
    });
  } catch (error) {
    console.error('Error general:', error);

    return res.status(500).json({
      error: error.message
    });
  }
}

function freshworksHeaders() {
  return {
    Authorization: `Token token=${process.env.FRESHWORKS_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

async function findFreshworksContactIdByEmail(email) {
  const lookupUrl =
    `${FW_BASE}/lookup?q=${encodeURIComponent(email)}` +
    `&f=email&entities=contact`;

  console.log('Buscando contacto Freshworks por email:', email);

  const lookupRes = await fetch(lookupUrl, {
    method: 'GET',
    headers: freshworksHeaders()
  });

  const lookupText = await lookupRes.text();
  const lookupData = safeJson(lookupText);

  if (!lookupRes.ok) {
    console.error('Error lookup Freshworks:', lookupText);
    return null;
  }

  const contacts = lookupData?.contacts?.contacts;

  if (Array.isArray(contacts) && contacts.length > 0) {
    return contacts[0].id;
  }

  return null;
}

async function updateFreshworksContactList(contactId) {
  const updateRes = await fetch(`${FW_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: freshworksHeaders(),
    body: JSON.stringify({
      contact: {
        contact_list_ids: [LIST_ID]
      }
    })
  });

  const text = await updateRes.text();

  return {
    ok: updateRes.ok,
    status: updateRes.status,
    text
  };
}

function isDuplicateContactError(errorData) {
  const messages = errorData?.errors?.message;

  if (!Array.isArray(messages)) {
    return false;
  }

  const joined = messages.join(' ').toLowerCase();

  return (
    joined.includes('ya existe') ||
    joined.includes('not unique') ||
    joined.includes('contact is not unique') ||
    joined.includes('email is not unique') ||
    joined.includes('mobilenumber is not unique')
  );
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

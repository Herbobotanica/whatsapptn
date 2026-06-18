// ============================================================
// Herbo Botánica — Sincronización automática de órdenes enviadas
// Corre cada 10 minutos (cron de Vercel)
// Flujo: Tienda Nube (órdenes "enviadas") → Freshworks CRM (contacto → lista) → Journey WhatsApp
// ============================================================

const TN_BASE  = `https://api.tiendanube.com/v1/${process.env.TN_STORE_ID}`;
const FW_BASE  = 'https://herbobotanica.myfreshworks.com/crm/sales/api';
const LIST_ID  = 27000020581; // Lista "Notificar Envio"

export default async function handler(req, res) {

  // Seguridad: solo aceptar llamadas con el CRON_SECRET correcto
  const secret = req.query.secret;
if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // ── 1. Traer órdenes enviadas en los últimos 30 minutos ──────────────
    const desde = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const tnRes = await fetch(
      `${TN_BASE}/orders?shipping_status=shipped&updated_at_min=${desde}&per_page=50`,
      {
        headers: {
          'Authentication': `bearer ${process.env.TN_ACCESS_TOKEN}`,
          'User-Agent': 'HerboBotanica (santacolomaeugenia@gmail.com)',
          'Content-Type': 'application/json'
        }
      }
    );

    if (!tnRes.ok) {
      const err = await tnRes.text();
      console.error('Error Tienda Nube:', err);
      return res.status(500).json({ error: 'Error al consultar Tienda Nube', detail: err });
    }

    const orders = await tnRes.json();

    if (!Array.isArray(orders) || orders.length === 0) {
      console.log('Sin órdenes nuevas enviadas.');
      return res.status(200).json({ processed: 0 });
    }

    console.log(`Órdenes a procesar: ${orders.length}`);

    let processed = 0;
    let errors    = [];

    for (const order of orders) {
      const customer = order.customer;

      // Saltear si no tiene teléfono ni email
      if (!customer?.phone && !customer?.email) {
        console.log(`Orden #${order.number} sin teléfono ni email, se saltea.`);
        continue;
      }

      const phone = customer.phone?.replace(/\D/g, '') || '';

      try {
        // ── 2. Buscar si el contacto ya existe en Freshworks CRM ────────
        const searchRes = await fetch(
          `${FW_BASE}/contacts/search?q=${encodeURIComponent(customer.email || phone)}&per_page=1`,
          {
            headers: {
              'Authorization': `Token token=${process.env.FRESHWORKS_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const searchData = await searchRes.json();
        const existing   = searchData?.contacts?.[0];

        if (existing) {
          // ── 3a. Contacto existe → agregar a la lista ─────────────────
          const updateRes = await fetch(`${FW_BASE}/contacts/${existing.id}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Token token=${process.env.FRESHWORKS_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              contact: {
                contact_list_ids: [LIST_ID]
              }
            })
          });

          if (!updateRes.ok) {
            const errBody = await updateRes.text();
            console.error(`Error actualizando contacto orden #${order.number}:`, errBody);
            errors.push({ order: order.number, error: errBody });
            continue;
          }

          console.log(`✓ (actualizado) Orden #${order.number} — ${customer.first_name} ${customer.last_name}`);

        } else {
          // ── 3b. Contacto nuevo → crear y agregar a la lista ──────────
          const createRes = await fetch(`${FW_BASE}/contacts`, {
            method: 'POST',
            headers: {
              'Authorization': `Token token=${process.env.FRESHWORKS_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              contact: {
                first_name:       customer.first_name || '',
                last_name:        customer.last_name  || '',
                mobile_number:    phone,
                email:            customer.email      || '',
                contact_list_ids: [LIST_ID]
              }
            })
          });

          if (!createRes.ok) {
            const errBody = await createRes.text();
            console.error(`Error creando contacto orden #${order.number}:`, errBody);
            errors.push({ order: order.number, error: errBody });
            continue;
          }

          console.log(`✓ (creado) Orden #${order.number} — ${customer.first_name} ${customer.last_name}`);
        }

        processed++;

      } catch (innerErr) {
        console.error(`Error procesando orden #${order.number}:`, innerErr.message);
        errors.push({ order: order.number, error: innerErr.message });
      }
    }

    return res.status(200).json({ processed, errors });

  } catch (error) {
    console.error('Error general:', error);
    return res.status(500).json({ error: error.message });
  }
}

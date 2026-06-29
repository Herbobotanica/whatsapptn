// ============================================================
// Herbo Botánica — Sincronización automática de órdenes enviadas
// Corre cada 10 minutos.
// Flujo:
// Tienda Nube (órdenes "enviadas") 
// → Freshworks CRM (contacto → campos → lista)
// → Cerrar/archivar orden en Tienda Nube
// → Journey WhatsApp se dispara desde Freshworks
// ============================================================

const TN_BASE = `https://api.tiendanube.com/v1/${process.env.TN_STORE_ID}`;
const FW_BASE = 'https://herbobotanica.myfreshworks.com/crm/sales/api';
const LIST_ID = 27000020581; // Lista "Notificar Envio"

export default async function handler(req, res) {
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

    // ── 1. Traer órdenes enviadas/actualizadas en los últimos 30 minutos ──────────────
    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const tnUrl =
      `${TN_BASE}/orders?shipping_status=fulfilled` +
      `&updated_at_min=${encodeURIComponent(desde)}` +
      `&per_page=50`;

    console.log('Consultando Tienda Nube:', tnUrl);

    const tnRes = await fetch(tnUrl, {
      headers: tiendaNubeHeaders()
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
          closed: 0,
          skippedClosed: 0,
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
        closed: 0,
        skippedClosed: 0,
        errors: []
      });
    }

    console.log(`Órdenes recibidas desde Tienda Nube: ${orders.length}`);

    let processed = 0;
    let closed = 0;
    let skippedClosed = 0;
    const errors = [];

    for (const order of orders) {
      // Si ya está cerrada/archivada, no la procesamos de nuevo.
      if (isOrderClosed(order)) {
        console.log(`Orden #${order.number} ya está cerrada/archivada. Se saltea.`);
        skippedClosed++;
        continue;
      }

      const customer = order.customer;

      if (!customer?.phone && !customer?.email) {
        console.log(`Orden #${order.number} sin teléfono ni email, se saltea.`);

        errors.push({
          order: order.number,
          stage: 'validation',
          error: 'Orden sin teléfono ni email'
        });

        continue;
      }

      const email = customer.email || order.contact_email || '';
      const phone = normalizePhone(customer.phone || order.contact_phone || '');
      const orderCustomFields = getOrderCustomFields(order);

      try {
        let contactId = null;

        // 2. Buscar contacto existente por email.
        if (email) {
          contactId = await findFreshworksContactIdByEmail(email);
        }

        // 3. Si no existe, crear contacto con campos custom.
        if (!contactId) {
          const createResult = await createFreshworksContact({
            firstName: getFirstName(order, customer),
            lastName: getLastName(order, customer),
            phone,
            email,
            customFields: orderCustomFields
          });

          if (!createResult.ok) {
            const duplicateByText = isDuplicateContactError(createResult.data);

            if (duplicateByText && email) {
              const retryContactId = await findFreshworksContactIdByEmail(email);

              if (retryContactId) {
                contactId = retryContactId;
              } else {
                errors.push({
                  order: order.number,
                  stage: 'freshworks_duplicate_lookup_failed',
                  status: createResult.status,
                  error: createResult.data
                });

                continue;
              }
            } else {
              console.error(`Error creando contacto orden #${order.number}:`, createResult.text);

              errors.push({
                order: order.number,
                stage: 'freshworks_create',
                status: createResult.status,
                error: createResult.data
              });

              continue;
            }
          } else {
            contactId = extractCreatedContactId(createResult.data);

            if (!contactId) {
              errors.push({
                order: order.number,
                stage: 'freshworks_create_no_id',
                error: createResult.data
              });

              continue;
            }

            console.log(
              `✓ Contacto creado - Orden #${order.number} — Contact ID ${contactId}`
            );
          }
        } else {
          console.log(
            `✓ Contacto existente encontrado - Orden #${order.number} — Contact ID ${contactId}`
          );
        }

        // 4. Actualizar campos custom del contacto:
        //    Medio de envío, tracking y número de orden.
        const updateFieldsResult = await updateFreshworksContactCustomFields(
          contactId,
          orderCustomFields
        );

        if (!updateFieldsResult.ok) {
          console.error(
            `Error actualizando campos del contacto orden #${order.number}:`,
            updateFieldsResult.text
          );

          errors.push({
            order: order.number,
            stage: 'freshworks_update_custom_fields',
            contactId,
            status: updateFieldsResult.status,
            error: safeJson(updateFieldsResult.text)
          });

          continue;
        }

        console.log(
          `✓ Campos actualizados - Orden #${order.number} — Medio: ${orderCustomFields.cf_medio_de_envio || '-'} — Tracking: ${orderCustomFields.cf_tracking_correo_argentino || '-'}`
        );

        // 5. Agregar contacto a la lista "Notificar Envio".
        const addListResult = await addFreshworksContactToList(contactId);

        if (!addListResult.ok) {
          console.error(
            `Error agregando contacto a lista orden #${order.number}:`,
            addListResult.text
          );

          errors.push({
            order: order.number,
            stage: 'freshworks_add_to_list',
            contactId,
            listId: LIST_ID,
            status: addListResult.status,
            error: safeJson(addListResult.text)
          });

          continue;
        }

        console.log(
          `✓ Contacto agregado a lista Notificar Envio - Orden #${order.number} — Contact ID ${contactId}`
        );

        // 6. Solo si Freshworks salió OK, cerramos/archivamos la orden en Tienda Nube.
        const closeResult = await closeTiendaNubeOrder(order.id);

        if (!closeResult.ok) {
          console.error(
            `Error cerrando/archivando orden #${order.number}:`,
            closeResult.text
          );

          errors.push({
            order: order.number,
            stage: 'tiendanube_close_order',
            orderId: order.id,
            status: closeResult.status,
            error: safeJson(closeResult.text)
          });

          // Ojo: Freshworks ya se procesó OK, pero la orden no se pudo archivar.
          // La dejamos como error para poder detectarlo.
          continue;
        }

        console.log(
          `✓ Orden cerrada/archivada en Tienda Nube - Orden #${order.number} — Order ID ${order.id}`
        );

        processed++;
        closed++;
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
      closed,
      skippedClosed,
      errors
    });
  } catch (error) {
    console.error('Error general:', error);

    return res.status(500).json({
      error: error.message
    });
  }
}

// ============================================================
// Headers
// ============================================================

function tiendaNubeHeaders() {
  return {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'User-Agent': 'HerboBotanica (santacolomaeugenia@gmail.com)',
    'Content-Type': 'application/json'
  };
}

function freshworksHeaders() {
  return {
    Authorization: `Token token=${process.env.FRESHWORKS_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

// ============================================================
// Tienda Nube helpers
// ============================================================

function isOrderClosed(order) {
  return Boolean(order.closed_at) || order.status === 'closed';
}

async function closeTiendaNubeOrder(orderId) {
  const closeRes = await fetch(`${TN_BASE}/orders/${orderId}/close`, {
    method: 'POST',
    headers: tiendaNubeHeaders()
  });

  const text = await closeRes.text();

  return {
    ok: closeRes.ok,
    status: closeRes.status,
    text
  };
}

// ============================================================
// Campos custom Freshworks
// ============================================================

function getOrderCustomFields(order) {
  return {
    cf_medio_de_envio: getShippingMethod(order),
    cf_tracking_correo_argentino: getTrackingNumber(order),
    cf_n_de_orden: order.number ? String(order.number) : ''
  };
}

function getShippingMethod(order) {
  return (
    order.shipping_option ||
    order.fulfillments?.[0]?.shipping?.option?.name ||
    order.shipping_carrier_name ||
    ''
  );
}

function getTrackingNumber(order) {
  return (
    order.shipping_tracking_number ||
    order.fulfillments?.[0]?.tracking_info?.code ||
    ''
  );
}

// ============================================================
// Datos básicos contacto
// ============================================================

function normalizePhone(phone) {
  return phone ? phone.replace(/\D/g, '') : '';
}

function getFirstName(order, customer) {
  if (customer.first_name) return customer.first_name;

  const name = customer.name || order.contact_name || '';
  return name.trim().split(' ')[0] || '';
}

function getLastName(order, customer) {
  if (customer.last_name) return customer.last_name;

  const name = customer.name || order.contact_name || '';
  const parts = name.trim().split(' ');

  if (parts.length <= 1) return '';

  return parts.slice(1).join(' ');
}

// ============================================================
// Freshworks CRM
// ============================================================

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

async function createFreshworksContact({ firstName, lastName, phone, email, customFields }) {
  const createRes = await fetch(`${FW_BASE}/contacts`, {
    method: 'POST',
    headers: freshworksHeaders(),
    body: JSON.stringify({
      contact: {
        first_name: firstName,
        last_name: lastName,
        mobile_number: phone,
        email,
        custom_field: customFields
      }
    })
  });

  const text = await createRes.text();
  const data = safeJson(text);

  return {
    ok: createRes.ok,
    status: createRes.status,
    text,
    data
  };
}

async function updateFreshworksContactCustomFields(contactId, customFields) {
  const updateRes = await fetch(`${FW_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: freshworksHeaders(),
    body: JSON.stringify({
      contact: {
        custom_field: customFields
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

async function addFreshworksContactToList(contactId) {
  const addRes = await fetch(`${FW_BASE}/lists/${LIST_ID}/add_contacts`, {
    method: 'PUT',
    headers: freshworksHeaders(),
    body: JSON.stringify({
      ids: [contactId]
    })
  });

  const text = await addRes.text();

  return {
    ok: addRes.ok,
    status: addRes.status,
    text
  };
}

// ============================================================
// Utilidades
// ============================================================

function extractCreatedContactId(data) {
  if (data?.contact?.id) {
    return data.contact.id;
  }

  if (data?.id) {
    return data.id;
  }

  return null;
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

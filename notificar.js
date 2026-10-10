const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const credencialesTexto = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!credencialesTexto) {
  throw new Error(
    "Falta el secreto FIREBASE_SERVICE_ACCOUNT_JSON."
  );
}

let credenciales;

try {
  credenciales = JSON.parse(credencialesTexto);
} catch {
  throw new Error(
    "El secreto FIREBASE_SERVICE_ACCOUNT_JSON no contiene JSON válido."
  );
}

initializeApp({
  credential: cert(credenciales)
});

const db = getFirestore();
const messaging = getMessaging();

// Evita procesar solicitudes antiguas anteriores a la activación.
const FECHA_ACTIVACION = new Date("2026-10-10T00:15:00Z");

// Si una ejecución se interrumpe, permite recuperar el proceso
// después de 15 minutos.
const TIEMPO_BLOQUEO_MS = 15 * 60 * 1000;

async function ejecutar() {
  console.log("=== VALERI'S MOTO TAXI ===");
  console.log("Inicio:", new Date().toISOString());

  const solicitudesSnapshot = await db
    .collection("requests")
    .where("status", "==", "pending")
    .get();

  const conductoresSnapshot = await db
    .collection("conductores")
    .where("estado", "==", "disponible")
    .get();

  const conductores = conductoresSnapshot.docs.filter(doc => {
    const datos = doc.data();

    return (
      typeof datos.fcmToken === "string" &&
      datos.fcmToken.trim().length > 0
    );
  });

  console.log(
    "Solicitudes pendientes:",
    solicitudesSnapshot.size
  );

  console.log(
    "Conductores disponibles con token:",
    conductores.length
  );

  let enviadas = 0;
  let omitidas = 0;
  let errores = 0;

  for (const solicitudDoc of solicitudesSnapshot.docs) {
    const solicitud = solicitudDoc.data();

    // No avisar si la solicitud ya tiene conductor asignado.
    if (solicitud.driverAuthUid) {
      omitidas++;
      continue;
    }

    // Verificar la fecha de creación.
    if (
      !solicitud.createdAt ||
      typeof solicitud.createdAt.toDate !== "function"
    ) {
      console.log(
        `Solicitud ${solicitudDoc.id}: falta una fecha válida.`
      );
      omitidas++;
      continue;
    }

    if (solicitud.createdAt.toDate() < FECHA_ACTIVACION) {
      omitidas++;
      continue;
    }

    for (const conductorDoc of conductores) {
      const conductor = conductorDoc.data();

      const marcaId =
        `${solicitudDoc.id}_${conductorDoc.id}`;

      const marcaRef = db
        .collection("notification_dispatches")
        .doc(marcaId);

      // Reservar el envío para reducir notificaciones duplicadas
      // si dos ejecuciones coinciden o una se interrumpe.
      let puedeEnviar = false;

      try {
        await db.runTransaction(async transaction => {
          const marcaSnapshot = await transaction.get(marcaRef);

          if (marcaSnapshot.exists) {
            const marca = marcaSnapshot.data();

            if (marca.estado === "enviada") {
              return;
            }

            if (marca.estado === "procesando") {
              const inicio = marca.inicioProcesamiento?.toDate?.();

              if (
                inicio &&
                Date.now() - inicio.getTime() < TIEMPO_BLOQUEO_MS
              ) {
                return;
              }
            }
          }

          transaction.set(
            marcaRef,
            {
              requestId: solicitudDoc.id,
              driverDocumentId: conductorDoc.id,
              estado: "procesando",
              inicioProcesamiento: new Date(),
              actualizadoEn: new Date()
            },
            { merge: true }
          );

          puedeEnviar = true;
        });

        if (!puedeEnviar) {
          omitidas++;
          continue;
        }

        // Comprobar de nuevo el estado antes de enviar.
        const solicitudActual = await solicitudDoc.ref.get();

        if (!solicitudActual.exists) {
          await marcaRef.set({
            estado: "omitida",
            motivo: "La solicitud ya no existe",
            actualizadoEn: new Date()
          }, { merge: true });

          omitidas++;
          continue;
        }

        const datosActuales = solicitudActual.data();

        if (
          datosActuales.status !== "pending" ||
          datosActuales.driverAuthUid
        ) {
          await marcaRef.set({
            estado: "omitida",
            motivo: "La solicitud ya no está disponible",
            actualizadoEn: new Date()
          }, { merge: true });

          omitidas++;
          continue;
        }

        const mensaje = {
          token: conductor.fcmToken.trim(),

          notification: {
            title: "Nueva solicitud de mototaxi",
            body:
              `${datosActuales.passengerName || "Un pasajero"} solicita un viaje: ` +
              `${datosActuales.pickup || "Punto de recojo"} → ` +
              `${datosActuales.destination || "Destino"}`
          },

          android: {
            priority: "high",
            notification: {
              channelId: "valeri_moto_taxi",
              sound: "default"
            }
          }
        };

        const mensajeId = await messaging.send(mensaje);

        await marcaRef.set({
          estado: "enviada",
          requestId: solicitudDoc.id,
          driverDocumentId: conductorDoc.id,
          sentAt: new Date(),
          fcmMessageId: mensajeId,
          actualizadoEn: new Date()
        }, { merge: true });

        enviadas++;

        console.log(
          `Envío aceptado por FCM: solicitud ${solicitudDoc.id}, ` +
          `conductor ${conductorDoc.id}`
        );

      } catch (error) {
        errores++;

        console.error(
          `Error en solicitud ${solicitudDoc.id}, ` +
          `conductor ${conductorDoc.id}:`,
          error.code || error.message
        );

        try {
          await marcaRef.set({
            estado: "error",
            ultimoError: String(error.code || error.message),
            actualizadoEn: new Date()
          }, { merge: true });
        } catch (errorRegistro) {
          console.error(
            "No se pudo registrar el error:",
            errorRegistro.message
          );
        }
      }
    }
  }

  console.log("=== RESUMEN ===");
  console.log("Envíos aceptados por FCM:", enviadas);
  console.log("Solicitudes o envíos omitidos:", omitidas);
  console.log("Errores:", errores);
  console.log("Fin:", new Date().toISOString());
}

ejecutar().catch(error => {
  console.error("Error general:", error.message);
  process.exitCode = 1;
});

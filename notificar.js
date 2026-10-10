const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const credencialesTexto = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (!credencialesTexto) {
  throw new Error("Falta el secreto FIREBASE_SERVICE_ACCOUNT_JSON.");
}

const credenciales = JSON.parse(credencialesTexto);

initializeApp({
  credential: cert(credenciales)
});

const db = getFirestore();
const messaging = getMessaging();

const FECHA_ACTIVACION = new Date("2026-10-10T00:15:00Z");

async function ejecutar() {
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
    return typeof datos.fcmToken === "string" &&
      datos.fcmToken.trim().length > 0;
  });

  console.log(`Conductores disponibles con token: ${conductores.length}`);

  for (const solicitudDoc of solicitudesSnapshot.docs) {
    const solicitud = solicitudDoc.data();

    if (solicitud.driverAuthUid) continue;

    if (
      !solicitud.createdAt ||
      typeof solicitud.createdAt.toDate !== "function" ||
      solicitud.createdAt.toDate() < FECHA_ACTIVACION
    ) {
      continue;
    }

    for (const conductorDoc of conductores) {
      const marcaId = `${solicitudDoc.id}_${conductorDoc.id}`;
      const marcaRef = db.collection("notification_dispatches").doc(marcaId);

      const marca = await marcaRef.get();
      if (marca.exists) continue;

      const conductor = conductorDoc.data();

      try {
        const mensaje = {
          token: conductor.fcmToken,
          notification: {
            title: "Nueva solicitud de mototaxi",
            body: `${solicitud.passengerName || "Un pasajero"} solicita un viaje: ${solicitud.pickup || "Punto de recojo"} → ${solicitud.destination || "Destino"}`
          },
          android: {
            priority: "high"
          }
        };

        const mensajeId = await messaging.send(mensaje);

        await marcaRef.set({
          requestId: solicitudDoc.id,
          driverDocumentId: conductorDoc.id,
          sentAt: new Date(),
          fcmMessageId: mensajeId
        });

        console.log(
          `Notificación enviada: solicitud ${solicitudDoc.id}, conductor ${conductorDoc.id}`
        );
      } catch (error) {
        console.error(
          `Error con solicitud ${solicitudDoc.id} y conductor ${conductorDoc.id}:`,
          error.code || error.message
        );
      }
    }
  }
}

ejecutar().catch(error => {
  console.error("Error general:", error.message);
  process.exitCode = 1;
});

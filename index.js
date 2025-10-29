import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import 'dotenv/config';
import admin from 'firebase-admin';
import EfiPay from 'sdk-node-apis-efi';
import crypto from 'crypto';

// ===================== FIREBASE ADMIN =====================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// ===================== EFI CONFIG =====================
const efi = new EfiPay({
  client_id: process.env.EFI_CLIENT_ID,
  client_secret: process.env.EFI_CLIENT_SECRET,
  certificate: process.env.EFI_CERT_PATH,
  sandbox: process.env.EFI_SANDBOX === 'true',
  headers: { 'x-scope': 'webhook.write webhook.read cob.write' },
  pemKey: process.env.EFI_CERT_PATH,
});

// ===================== EXPRESS =====================
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===================== UTILIDADES =====================
const newId = () => crypto.randomUUID();

// ===================== CRIAR COBRANÇA PIX =====================
app.post('/api/pix/create', async (req, res) => {
  try {
    const { orderId, amount, description } = req.body;
    if (!orderId || !amount) return res.status(400).json({ error: 'orderId e amount obrigatórios' });

    const chargeBody = {
      calendario: { expiracao: 3600 },
      valor: { original: parseFloat(amount).toFixed(2).toString() },
      chave: process.env.EFI_PIX_KEY,
      solicitacaoPagador: description || 'Impressão de arquivo',
    };

    const charge = await efi.pixCreateImmediateCharge([], chargeBody);

    const { qrcode, imagemQrcode } = await efi.pixGenerateQRCode({ id: charge.loc.id });

    await db.collection("orders").doc(orderId).set({
      txid: charge.txid,
      orderId,
      amount: charge.valor.original,
      description,
      status: 'aguardando_pagamento',
      pagamentoConfirmado: false,
      createdAt: new Date(),
    });

    res.json({ orderId, txid: charge.txid, qrcode, qrImage: imagemQrcode });
  } catch (err) {
    console.error("Erro ao criar Pix:", err.response?.data || err.message || err);
    res.status(500).json({ error: 'Falha ao criar Pix' });
  }
});

// ===================== WEBHOOK EFI =====================
app.post("/webhook/efi/pix/pix", async (req, res) => {
  try {
    const pixNotifications = req.body.pix;
    console.log("Webhook recebido:", pixNotifications);

    if (!pixNotifications || !pixNotifications.length) return res.sendStatus(200);

    for (const pagamento of pixNotifications) {
      const txid = pagamento.txid;
      const pedidoSnap = await db.collection("orders").where("txid", "==", txid).get();
      if (!pedidoSnap.empty) {
        const pedidoDoc = pedidoSnap.docs[0];
        await pedidoDoc.ref.update({
          status: "Preparando",
          pagamentoConfirmado: true,
          updatedAt: new Date(),
        });
        console.log(`Pedido ${pedidoDoc.id} atualizado: pagamento confirmado`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook EFI:", err);
    res.sendStatus(500);
  }
});

// ===================== HEALTHCHECK =====================
app.get('/health', (_, res) => res.json({ ok: true }));

// ===================== START SERVER =====================
const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log(`API Pix rodando na porta ${port}`);

  // ===================== REGISTRA WEBHOOK EFI =====================
  try {
    const params = { chave: process.env.EFI_PIX_KEY };
    const body = { webhookUrl: `${process.env.BASE_URL}/webhook/efi` }; // sem /pix
    const r = await efi.pixConfigWebhook(params, body);
    console.log("✅ Webhook cadastrado:", r);
  } catch (err) {
    console.error("❌ Erro ao cadastrar webhook:", err.response?.data || err);
  }
});

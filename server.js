const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const admin = require('firebase-admin');

// 1. FIREBASE SETUP
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. WHATSAPP CLIENT SETUP
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// Helper function to update Status to HTML UI
async function updateStatus(state, qrUrl = "") {
    await db.collection('wa_system').doc('status').set({
        state: state,
        qrCodeUrl: qrUrl,
        updatedAt: Date.now()
    });
    console.log(`[STATUS] System state updated to: ${state}`);
}

client.on('qr', async (qr) => {
    console.log('[WHATSAPP] QR Code received. Generating Base64...');
    const qrBase64 = await qrcode.toDataURL(qr);
    await updateStatus('QR_READY', qrBase64);
});

client.on('ready', async () => {
    console.log('[WHATSAPP] Client is ready and connected!');
    await updateStatus('CONNECTED');
    startQueueProcessor(); // Start processing the Firebase queue
});

client.on('disconnected', async (reason) => {
    console.log('[WHATSAPP] Client was logged out', reason);
    await updateStatus('DISCONNECTED');
});

// Start the client
console.log('Starting WhatsApp Web Engine...');
updateStatus('STARTING');
client.initialize();

// 3. LOGOUT COMMAND LISTENER (Triggered from HTML button)
db.collection('wa_system').doc('commands').onSnapshot(async (doc) => {
    if(doc.exists && doc.data().command === 'LOGOUT') {
        console.log('[COMMAND] Admin requested Logout.');
        await client.logout();
        await db.collection('wa_system').doc('commands').delete();
    }
});

// 4. THE ANTI-SPAM QUEUE PROCESSOR
let isProcessing = false;

async function startQueueProcessor() {
    if(isProcessing) return;
    isProcessing = true;

    // Check Firebase for Pending messages continuously every 3 seconds
    setInterval(async () => {
        try {
            const snapshot = await db.collection('wa_queue')
                                     .where('status', '==', 'Pending')
                                     .orderBy('timestamp', 'asc')
                                     .limit(1) // Pick 1 message at a time
                                     .get();
            
            if(snapshot.empty) return; // Nothing to send

            const doc = snapshot.docs[0];
            const data = doc.data();
            
            let phoneStr = String(data.memberPhone).replace(/[^0-9]/g, '');
            if(!phoneStr.startsWith('91')) phoneStr = '91' + phoneStr; // Default India code if missing
            const chatId = phoneStr + '@c.us';

            console.log(`[QUEUE] Sending message to ${data.memberName} (${chatId})...`);

            try {
                if(data.mediaUrl && data.mediaUrl.length > 5) {
                    const media = await MessageMedia.fromUrl(data.mediaUrl);
                    await client.sendMessage(chatId, media, { caption: data.messageText });
                } else {
                    await client.sendMessage(chatId, data.messageText);
                }
                
                // Success - Update Firebase
                await doc.ref.update({ status: 'Sent', sentAt: Date.now() });
                console.log(`✅ Sent successfully to ${data.memberName}.`);

            } catch(e) {
                console.log(`❌ Failed to send to ${data.memberName}: ${e.message}`);
                await doc.ref.update({ status: 'Failed', error: e.message });
            }

            // --- ANTI-BAN DELAY ---
            // Wait a random time between 5 and 12 seconds before processing the next message
            const randomDelay = Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000;
            console.log(`[ANTI-SPAM] Waiting ${randomDelay/1000} seconds before next message...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

        } catch(error) {
            console.error('[PROCESSOR ERROR]', error);
        }
    }, 3000); // Polling interval
}

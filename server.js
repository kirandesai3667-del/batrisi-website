const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const admin = require('firebase-admin');

// 1. FIREBASE SETUP
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 2. WHATSAPP CLIENT SETUP (Stable Flags)
let client;

function initializeWhatsAppClient() {
    updateStatus('STARTING');
    
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './wa_session' }), // Saves session robustly
        puppeteer: { 
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu'
            ] 
        }
    });

    // Helper: Update Firebase Status
    async function updateStatus(state, qrUrl = "") {
        await db.collection('wa_system').doc('status').set({
            state: state,
            qrCodeUrl: qrUrl,
            updatedAt: Date.now()
        });
        console.log(`[STATUS] System state updated to: ${state}`);
    }

    client.on('qr', async (qr) => {
        console.log('[WHATSAPP] Fresh QR Code generated. Sending to UI...');
        // High quality rendering to prevent broken QR
        const qrBase64 = await qrcode.toDataURL(qr, { errorCorrectionLevel: 'H', margin: 2, width: 400 });
        await updateStatus('QR_READY', qrBase64);
    });

    client.on('authenticated', () => {
        console.log('[WHATSAPP] Authenticated via Local Session!');
        updateStatus('RECONNECTING'); // Visual state before ready
    });

    client.on('auth_failure', async msg => {
        console.error('[WHATSAPP] Authentication Failed!', msg);
        await updateStatus('DISCONNECTED');
    });

    client.on('ready', async () => {
        console.log('[WHATSAPP] Client is completely READY!');
        await updateStatus('CONNECTED');
        startQueueProcessor(); 
    });

    client.on('disconnected', async (reason) => {
        console.log('[WHATSAPP] Client was disconnected. Reason:', reason);
        await updateStatus('DISCONNECTED');
        // Auto Restart logic
        setTimeout(() => {
            console.log('Restarting client after disconnect...');
            client.initialize();
        }, 5000);
    });

    console.log('Booting WhatsApp Engine...');
    client.initialize();
}

initializeWhatsAppClient(); // Start for first time

// 3. ADMIN COMMAND LISTENER
db.collection('wa_system').doc('commands').onSnapshot(async (doc) => {
    if(!doc.exists) return;
    const data = doc.data();

    if(data.command === 'LOGOUT') {
        console.log('[COMMAND] Admin requested Logout. Erasing Session...');
        try {
            await client.logout(); 
            // It will trigger disconnected event and start fresh
        } catch(e) { console.error("Logout Error:", e); }
        await db.collection('wa_system').doc('commands').delete();
    }
    
    if(data.command === 'RESTART') {
        console.log('[COMMAND] Admin requested Restart.');
        try { await client.destroy(); } catch(e){}
        setTimeout(() => initializeWhatsAppClient(), 2000);
        await db.collection('wa_system').doc('commands').delete();
    }
});

// 4. ROBUST ANTI-SPAM QUEUE PROCESSOR
let isProcessing = false;

async function startQueueProcessor() {
    if(isProcessing) return;
    isProcessing = true;

    setInterval(async () => {
        try {
            // Check if connected before trying to send
            const statusDoc = await db.collection('wa_system').doc('status').get();
            if(statusDoc.data().state !== 'CONNECTED') return;

            const snapshot = await db.collection('wa_queue')
                                     .where('status', '==', 'Pending')
                                     .orderBy('timestamp', 'asc')
                                     .limit(1) 
                                     .get();
            
            if(snapshot.empty) return; 

            const doc = snapshot.docs[0];
            const data = doc.data();
            
            let phoneStr = String(data.memberPhone).replace(/[^0-9]/g, '');
            if(!phoneStr) { await doc.ref.update({ status: 'Failed', error: 'Invalid Number' }); return; }
            if(!phoneStr.startsWith('91')) phoneStr = '91' + phoneStr; 
            const chatId = phoneStr + '@c.us';

            console.log(`[QUEUE] Sending message to ${data.memberName} (${chatId})...`);

            try {
                if(data.mediaUrl && data.mediaUrl.length > 5) {
                    const media = await MessageMedia.fromUrl(data.mediaUrl);
                    await client.sendMessage(chatId, media, { caption: data.messageText });
                } else {
                    await client.sendMessage(chatId, data.messageText);
                }
                
                await doc.ref.update({ status: 'Sent', sentAt: Date.now() });
                console.log(`✅ Sent successfully to ${data.memberName}.`);

            } catch(e) {
                console.log(`❌ Failed to send to ${data.memberName}: ${e.message}`);
                await doc.ref.update({ status: 'Failed', error: e.message });
            }

            // ANTI-BAN RANDOM DELAY (5 to 12 Seconds)
            const randomDelay = Math.floor(Math.random() * (12000 - 5000 + 1)) + 5000;
            console.log(`[ANTI-SPAM] Holding for ${randomDelay/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

        } catch(error) {
            console.error('[PROCESSOR ERROR]', error.message);
        }
    }, 3000); 
}

// Global Crash Handlers (Keeps server alive)
process.on('unhandledRejection', (reason, promise) => { console.log('Unhandled Rejection at:', promise, 'reason:', reason); });
process.on('uncaughtException', (error) => { console.log('Uncaught Exception:', error); });

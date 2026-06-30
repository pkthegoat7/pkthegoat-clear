/**
 * self-browser: abre o Discord web logado como o self num Chromium headless e
 * transmite a tela (screencast CDP, jpeg) por WebSocket, recebendo mouse/teclado
 * de volta. Uma sessão de browser por conexão WS; fecha por desconexão ou
 * ociosidade para liberar RAM.
 *
 * Fluxo: cliente conecta em /stream?ticket=... -> valida ticket -> carrega token
 * do Supabase -> lança Chromium -> injeta token no discord.com -> screencast.
 *
 * Envs: PORT, BROWSER_SHARED_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * ENCRYPTION_KEY, [ALLOW_ORIGIN].
 */

const http = require('http');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');
const { verificarTicket } = require('./ticket');
const { carregarTokenPorNome } = require('./supabase-tokens');

const PORT = Number(process.env.PORT) || 8090;
const SEGREDO = process.env.BROWSER_SHARED_SECRET || '';
const VIEWPORT = { width: 1280, height: 720 };
const IDLE_MS = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }
    res.writeHead(404);
    res.end();
});

const wss = new WebSocketServer({ server, path: '/stream', maxPayload: 4 * 1024 * 1024 });

wss.on('connection', async (ws, req) => {
    console.log('[self-browser] conexão WS recebida');
    if (!SEGREDO) { ws.close(4500, 'serviço sem segredo configurado'); return; }
    const url = new URL(req.url, 'http://x');
    const dados = verificarTicket(url.searchParams.get('ticket') || '', SEGREDO);
    if (!dados) { ws.close(4001, 'ticket inválido'); return; }
    console.log('[self-browser] ticket OK p/', dados.email, '/', dados.nome);

    let token = null;
    try { token = await carregarTokenPorNome(dados.email, dados.nome); }
    catch (e) { console.error('[self-browser] erro carregarToken:', e && e.stack || e); }
    if (!token) { ws.close(4002, 'token não encontrado'); return; }

    let browser = null, context = null, page = null, cdp = null, idleTimer = null, ff = null, audioTimer = null;
    let fechando = false;

    const sendJson = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };
    const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { sendJson({ t: 'idle' }); ws.close(4003, 'ociosidade'); }, IDLE_MS);
    };
    const limpar = async () => {
        if (fechando) return; fechando = true;
        clearTimeout(idleTimer);
        clearInterval(audioTimer);
        try { ff?.kill('SIGKILL'); } catch {}
        try { await cdp?.send('Page.stopScreencast'); } catch {}
        try { await context?.close(); } catch {}
        try { await browser?.close(); } catch {}
    };

    ws.on('close', limpar);
    ws.on('error', limpar);

    try {
        browser = await chromium.launch({
            // Playwright 1.49+ usa o "new headless" por padrão com headless:true:
            // renderiza offscreen (screencast OK) E emite áudio pelo PulseAudio.
            headless: true,
            args: [
                '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
                '--autoplay-policy=no-user-gesture-required',
                `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
            ]
        });
        context = await browser.newContext({ viewport: VIEWPORT, userAgent: UA, locale: 'pt-BR' });
        page = await context.newPage();

        sendJson({ t: 'status', msg: 'abrindo discord…' });
        await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Injeta o token via localStorage de um iframe same-origin (o Discord
        // remove o localStorage da janela principal; o iframe contorna isso).
        await page.evaluate((t) => {
            const i = document.createElement('iframe');
            document.body.appendChild(i);
            try { i.contentWindow.localStorage.setItem('token', '"' + t + '"'); } catch (e) {}
            i.remove();
        }, token);

        await page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded', timeout: 30000 });

        cdp = await context.newCDPSession(page);
        // Em headless a página é tratada como sem foco/oculta, e o Discord ignora
        // ou estrangula a interação. Emular foco faz o input (mouse/teclado)
        // realmente surtir efeito.
        try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
        try { await page.bringToFront(); } catch {}
        cdp.on('Page.screencastFrame', async (f) => {
            sendJson({ t: 'frame', data: f.data, meta: f.metadata });
            try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
        });
        await cdp.send('Page.startScreencast', {
            format: 'jpeg', quality: 50,
            // everyNthFrame:2 reduz a taxa de vídeo p/ deixar banda para o áudio.
            maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 2
        });

        sendJson({ t: 'pronto', viewport: VIEWPORT, audio: { sampleRate: 48000, channels: 1 } });
        resetIdle();

        // ÁUDIO (escutar): captura o monitor do sink "virtual" (onde o Chromium
        // toca) com `parec`, e envia PCM s16le mono 48k como mensagens BINÁRIAS,
        // pacejado a ~96KB/s no Node (o null sink ocioso entrega em rajada e
        // saturaria o WS, derrubando o vídeo). Descarta o excesso antigo.
        try {
            ff = spawn('parec', ['--device=virtual.monitor', '--format=s16le', '--rate=48000', '--channels=1']);
            const BPS = 48000 * 2, CAP = BPS, TICK = 100;
            let abuf = [], abytes = 0;
            ff.stdout.on('data', (chunk) => {
                abuf.push(chunk); abytes += chunk.length;
                while (abytes > CAP && abuf.length > 1) { abytes -= abuf.shift().length; }
            });
            ff.stderr.on('data', (d) => console.error('[parec]', String(d).slice(0, 200)));
            ff.on('error', (e) => console.error('[parec] spawn falhou:', e.message));
            audioTimer = setInterval(() => {
                // Áudio é pequeno e prioritário; só recua se a conexão estiver
                // MUITO atrasada (1MB) — antes o vídeo enchia o buffer e starvava.
                if (ws.readyState !== 1 || ws.bufferedAmount > 1024 * 1024) return;
                let need = Math.round(BPS * TICK / 1000);
                const out = [];
                while (need > 0 && abuf.length) {
                    const head = abuf[0];
                    if (head.length <= need) { out.push(head); need -= head.length; abytes -= head.length; abuf.shift(); }
                    else { out.push(head.subarray(0, need)); abuf[0] = head.subarray(need); abytes -= need; need = 0; }
                }
                if (out.length) { try { ws.send(Buffer.concat(out), { binary: true }); } catch {} }
            }, TICK);
        } catch (e) {
            console.error('[self-browser] áudio indisponível:', e.message);
        }

        // Mensagens do cliente: TEXTO = input (mouse/teclado JSON). (Binário = mic,
        // tratado na Etapa 2.)
        ws.on('message', async (data, isBinary) => {
            resetIdle();
            if (isBinary) return; // mic entra na Etapa 2
            let m; try { m = JSON.parse(data.toString()); } catch { return; }
            try { await aplicarInput(cdp, page, m); } catch {}
        });
    } catch (e) {
        sendJson({ t: 'erro', msg: (e && e.message) || 'falha ao abrir o browser' });
        try { ws.close(4500, 'falha'); } catch {}
        await limpar();
    }
});

// Encaminha mouse/teclado do cliente para a página via CDP.
async function aplicarInput(cdp, page, m) {
    if (!cdp) return;
    if (m.t === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', {
            type: m.type, // mousePressed | mouseReleased | mouseMoved | mouseWheel
            x: Math.round(m.x || 0), y: Math.round(m.y || 0),
            button: m.button || 'none',
            buttons: m.buttons || 0,
            clickCount: m.clickCount || 0,
            deltaX: m.deltaX || 0, deltaY: m.deltaY || 0
        });
    } else if (m.t === 'key') {
        await cdp.send('Input.dispatchKeyEvent', {
            type: m.type, // keyDown | keyUp | rawKeyDown
            key: m.key, code: m.code,
            windowsVirtualKeyCode: m.keyCode || 0,
            text: m.text || undefined
        });
    } else if (m.t === 'text') {
        await cdp.send('Input.insertText', { text: String(m.text || '') });
    }
}

server.listen(PORT, () => console.log(`[self-browser] v9-silence ouvindo em :${PORT}`));

process.on('unhandledRejection', (e) => console.error('[self-browser] unhandledRejection', e?.message || e));

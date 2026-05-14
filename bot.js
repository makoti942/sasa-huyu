const WebSocket = require('ws');

// CONFIGURATION
const TOKEN = 'wPwDlHvQ3BEUvs8'; // Replace with your actual token
const STAKE = 0.35;
const SYMBOL = '1HZ100V'; // High-frequency 1s synthetic
const APP_ID = 101585; // Default Deriv AppID or your own

// DISABLED - replaced by DerivAuth.js
// const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);

// STRATEGY: PACKET INJECTION
ws.on('open', () => {
    console.log('CONNECTED TO LONDON GATEWAY');
    ws.send(JSON.stringify({ authorize: TOKEN }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);

    // 1. AFTER AUTHORIZATION, SUBSCRIBE TO TICKS
    if (msg.msg_type === 'authorize') {
        console.log('AUTHORIZED. STARTING HIGH-SPEED SNIFFER...');
        ws.send(JSON.stringify({ ticks: SYMBOL }));
    }

    // 2. THE STRIKE: ZERO-LATENCY INJECTION
    if (msg.msg_type === 'tick') {
        const quote = msg.tick.quote.toString();
        const digit = quote.charAt(quote.length - 1);

        // IMMEDIATE RETURN PACKET
        const request = JSON.stringify({
            buy: 1,
            price: STAKE,
            parameters: {
                amount: STAKE,
                basis: 'stake',
                contract_type: 'DIGITMATCH',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: SYMBOL,
                barrier: parseInt(digit)
            }
        });

        ws.send(request);
        process.stdout.write(`\rSTRIKING DIGIT: ${digit} | LATENCY: ${Date.now() - msg.tick.epoch*1000}ms`);
    }

    // 3. LOG RESULTS
    if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract.is_sold) {
        const c = msg.proposal_open_contract;
        console.log(`\nRESULT: ${c.status.toUpperCase()} | ENTRY: ${c.entry_tick_display_value.slice(-1)} | EXIT: ${c.exit_tick_display_value.slice(-1)}`);
    }
});

ws.on('error', (e) => console.log('SOCKET ERROR:', e));

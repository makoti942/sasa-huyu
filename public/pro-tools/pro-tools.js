const ENDPOINT = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
let ws = null;
let currentSymbol = null;
const symbolMeta = new Map();
let currentPipSize = null;
let MAX_SAMPLES = 1000;
let digitsQueue = [];
const symbolsEl = document.getElementById('volatility-index');
const ticksWindowEl = document.getElementById('number-digits');
const eoEvenPctEl = document.getElementById('eo-even-pct');
const eoOddPctEl = document.getElementById('eo-odd-pct');
const footerLeftLabel = document.getElementById('footer-left-label');
const footerRightLabel = document.getElementById('footer-right-label');
const wsStatusEl = document.getElementById('ws-status');
const livePriceEl = document.getElementById('live-price');
const eoChipsEl = document.getElementById('eo-chips');
const digitsSequenceEl = document.getElementById('digits-sequence');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebar = document.getElementById('sidebar');
const mobileOverlay = document.getElementById('mobile-overlay');
const svgChart = document.getElementById('eo-chart');
const svgEvenRect = document.getElementById('bar-even-rect');
const svgOddRect = document.getElementById('bar-odd-rect');
const svgEvenText = document.getElementById('bar-even-text');
const svgOddText = document.getElementById('bar-odd-text');
const ouInput = document.getElementById('ou-threshold');
const ouSummary = document.getElementById('ou-summary');
const ouChart = document.getElementById('ou-chart');
const ouOverChart = document.getElementById('ou-over-chart');
const ouUnderChart = document.getElementById('ou-under-chart');
const ouChipsEl = document.getElementById('ou-chips');
const mdInput = document.getElementById('md-digit');
const mdSummary = document.getElementById('md-summary');
const mdChipsEl = document.getElementById('md-chips');
const mdHistChart = document.getElementById('md-hist-chart');
const rfChart = document.getElementById('rf-chart');
const rfRiseRect = document.getElementById('rf-rise-rect');
const rfEqualRect = document.getElementById('rf-equal-rect');
const rfFallRect = document.getElementById('rf-fall-rect');
const rfRiseText = document.getElementById('rf-rise-text');
const rfEqualText = document.getElementById('rf-equal-text');
const rfFallText = document.getElementById('rf-fall-text');
const rfChipsEl = document.getElementById('rf-chips');
const tabEo = document.getElementById('tab-eo');
const tabOu = document.getElementById('tab-ou');
const sectionEo = document.getElementById('section-eo');
const sectionOu = document.getElementById('section-ou');
const tabMd = document.getElementById('tab-md');
const sectionMd = document.getElementById('section-md');
const tabRf = document.getElementById('tab-rf');
const sectionRf = document.getElementById('section-rf');
function setActiveTab(active) {
    const tabs = [tabEo, tabOu, tabMd, tabRf];
    tabs.forEach(t => t && t.classList.remove('bg-blue-700'));
    if (active) active.classList.add('bg-blue-700');
}
function showEO() {
    setActiveTab(tabEo);
    if (sectionEo) sectionEo.style.display = '';
    if (sectionOu) sectionOu.style.display = 'none';
    if (sectionMd) sectionMd.style.display = 'none';
    if (sectionRf) sectionRf.style.display = 'none';
    updateEvenOdd();
}
function showOU() {
    setActiveTab(tabOu);
    if (sectionOu) sectionOu.style.display = '';
    if (sectionEo) sectionEo.style.display = 'none';
    if (sectionMd) sectionMd.style.display = 'none';
    if (sectionRf) sectionRf.style.display = 'none';
    updateOverUnder();
}
if (tabEo)
    tabEo.addEventListener('click', () => {
        showEO();
    });
if (tabOu)
    tabOu.addEventListener('click', () => {
        showOU();
    });
if (tabMd)
    tabMd.addEventListener('click', () => {
        setActiveTab(tabMd);
        if (sectionMd) sectionMd.style.display = '';
        if (sectionEo) sectionEo.style.display = 'none';
        if (sectionOu) sectionOu.style.display = 'none';
        if (sectionRf) sectionRf.style.display = 'none';
        updateMatchDiffer();
    });
if (tabRf)
    tabRf.addEventListener('click', () => {
        setActiveTab(tabRf);
        if (sectionRf) sectionRf.style.display = '';
        if (sectionEo) sectionEo.style.display = 'none';
        if (sectionOu) sectionOu.style.display = 'none';
        if (sectionMd) sectionMd.style.display = 'none';
        updateRiseFall();
    });
function toFixedWithPip(price, pipSize) {
    const ps = Number.isFinite(pipSize) ? pipSize : 2;
    return Number(price).toFixed(ps);
}
function extractLastDigit(price, pipSize) {
    const s = toFixedWithPip(price, pipSize).replace('.', '');
    const ch = s.charAt(s.length - 1);
    const d = Number(ch);
    return Number.isFinite(d) ? d : 0;
}
function resetStats() {
    digitsQueue = [];
    updateEvenOdd();
    updateOverUnder();
    updateMatchDiffer();
    updateRiseFall();
}
function pushDigit(d) {
    digitsQueue.push(d);
    if (digitsQueue.length > MAX_SAMPLES) digitsQueue.shift();
    updateDigitsSequence();
    updateEvenOdd();
}
function updateDigitsSequence() {
    if (digitsSequenceEl) {
        const sequence = digitsQueue.slice(-60).join(', ');
        digitsSequenceEl.textContent = sequence || 'Loading...';
    }
}
function drawGridOnce() {
    if (!svgChart || svgChart.__gridDrawn) return;
    const ns = 'http://www.w3.org/2000/svg';
    const TOP_Y = 10;
    const BOTTOM_Y = 250;
    const HEIGHT = BOTTOM_Y - TOP_Y;
    const STEP = HEIGHT / 10;
    for (let i = 0; i <= 10; i++) {
        const y = BOTTOM_Y - i * STEP;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', '80');
        line.setAttribute('x2', '380');
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        line.setAttribute('class', 'grid-line');
        svgChart.appendChild(line);
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', '60');
        label.setAttribute('y', String(y + 4));
        label.setAttribute('class', 'grid-label');
        label.textContent = String(i * 10);
        svgChart.appendChild(label);
    }
    svgChart.__gridDrawn = true;
}
function drawOuGridOnce() {
    if (!ouChart || ouChart.__gridDrawn) return;
    const ns = 'http://www.w3.org/2000/svg';
    const TOP_Y = 10;
    const BOTTOM_Y = 250;
    const HEIGHT = BOTTOM_Y - TOP_Y;
    const STEP = HEIGHT / 10;
    for (let i = 0; i <= 10; i++) {
        const y = BOTTOM_Y - i * STEP;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', '80');
        line.setAttribute('x2', '380');
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        line.setAttribute('class', 'grid-line');
        ouChart.appendChild(line);
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', '60');
        label.setAttribute('y', String(y + 4));
        label.setAttribute('class', 'grid-label');
        label.textContent = String(i * 10);
        ouChart.appendChild(label);
    }
    ouChart.__gridDrawn = true;
}
function drawMdHistGridOnce() {
    if (!mdHistChart || mdHistChart.__gridDrawn) return;
    const ns = 'http://www.w3.org/2000/svg';
    const TOP_Y = 10,
        BOTTOM_Y = 250,
        HEIGHT = BOTTOM_Y - TOP_Y,
        STEP = HEIGHT / 10;
    for (let i = 0; i <= 10; i++) {
        const y = BOTTOM_Y - i * STEP;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', '50');
        line.setAttribute('x2', '380');
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        line.setAttribute('class', 'grid-line');
        mdHistChart.appendChild(line);
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', '30');
        label.setAttribute('y', String(y + 4));
        label.setAttribute('class', 'grid-label');
        label.textContent = String(i * 10);
        mdHistChart.appendChild(label);
    }
    const title = document.createElementNS(ns, 'text');
    title.setAttribute('x', '215');
    title.setAttribute('y', '20');
    title.setAttribute('class', 'grid-label');
    title.setAttribute('text-anchor', 'middle');
    title.textContent = 'Digit distribution (09)';
    mdHistChart.appendChild(title);
    mdHistChart.__gridDrawn = true;
}
function drawRfGridOnce() {
    if (!rfChart || rfChart.__gridDrawn) return;
    const ns = 'http://www.w3.org/2000/svg';
    const TOP_Y = 10,
        BOTTOM_Y = 250,
        HEIGHT = BOTTOM_Y - TOP_Y,
        STEP = HEIGHT / 10;
    for (let i = 0; i <= 10; i++) {
        const y = BOTTOM_Y - i * STEP;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', '80');
        line.setAttribute('x2', '380');
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        line.setAttribute('class', 'grid-line');
        rfChart.appendChild(line);
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', '60');
        label.setAttribute('y', String(y + 4));
        label.setAttribute('class', 'grid-label');
        label.textContent = String(i * 10);
        rfChart.appendChild(label);
    }
    rfChart.__gridDrawn = true;
}
function updateEvenOdd() {
    let even = 0,
        odd = 0;
    for (let i = 0; i < digitsQueue.length; i++) {
        const v = digitsQueue[i];
        if (v % 2 === 0) even++;
        else odd++;
    }
    const total = Math.max(digitsQueue.length, 1);
    const evenPctNum = (even / total) * 100;
    const oddPctNum = (odd / total) * 100;
    const evenPct = `${evenPctNum.toFixed(2)}%`;
    const oddPct = `${oddPctNum.toFixed(2)}%`;
    const eoEvenPercentageEl = document.getElementById('eo-even-percentage');
    const eoOddPercentageEl = document.getElementById('eo-odd-percentage');
    if (eoEvenPercentageEl) eoEvenPercentageEl.textContent = evenPct;
    if (eoOddPercentageEl) eoOddPercentageEl.textContent = oddPct;
    drawGridOnce();
    if (svgEvenRect && svgOddRect && svgEvenText && svgOddText) {
        const TOP_Y = 10;
        const BOTTOM_Y = 250;
        const H = BOTTOM_Y - TOP_Y;
        const evenH = (evenPctNum / 100) * H;
        const oddH = (oddPctNum / 100) * H;
        svgEvenRect.setAttribute('y', String(BOTTOM_Y - evenH));
        svgEvenRect.setAttribute('height', String(evenH));
        svgOddRect.setAttribute('y', String(BOTTOM_Y - oddH));
        svgOddRect.setAttribute('height', String(oddH));
        svgEvenText.textContent = evenPct;
        svgOddText.textContent = oddPct;
        svgEvenText.setAttribute('y', String(BOTTOM_Y - evenH - 6));
        svgOddText.setAttribute('y', String(BOTTOM_Y - oddH - 6));
    }
}
function updateOverUnder() {
    const threshold = parseInt(ouInput && ouInput.value, 10);
    if (!Number.isFinite(threshold)) return;
    let under = 0,
        equal = 0,
        over = 0;
    for (let i = 0; i < digitsQueue.length; i++) {
        const v = digitsQueue[i];
        if (v < threshold) under++;
        else if (v > threshold) over++;
        else equal++;
    }
    const total = Math.max(digitsQueue.length, 1);
    const uPct = (under / total) * 100;
    const ePct = (equal / total) * 100;
    const oPct = (over / total) * 100;
    if (ouSummary)
        ouSummary.textContent = `Under: ${uPct.toFixed(1)}% | Equal: ${ePct.toFixed(1)}% | Over: ${oPct.toFixed(1)}%`;
    const ouOverPercentageEl = document.getElementById('ou-over-percentage');
    const ouUnderPercentageEl = document.getElementById('ou-under-percentage');
    if (ouOverPercentageEl) ouOverPercentageEl.textContent = `${oPct.toFixed(2)}%`;
    if (ouUnderPercentageEl) ouUnderPercentageEl.textContent = `${uPct.toFixed(2)}%`;
    const counts = new Array(10).fill(0);
    for (let i = 0; i < digitsQueue.length; i++) counts[digitsQueue[i]]++;
    const prefix = new Array(10).fill(0);
    const suffix = new Array(10).fill(0);
    for (let i = 0; i < 10; i++) prefix[i] = counts[i] + (i > 0 ? prefix[i - 1] : 0);
    for (let i = 9; i >= 0; i--) suffix[i] = counts[i] + (i < 9 ? suffix[i + 1] : 0);
    const ns = 'http://www.w3.org/2000/svg';
    const TOP_Y = 10,
        BOTTOM_Y = 250,
        H = BOTTOM_Y - TOP_Y;
    function renderSeries(chartEl, values, title) {
        if (!chartEl) return;
        if (!chartEl.__gridDrawn) {
            const chartWidth = chartEl.getBoundingClientRect().width;
            const right = chartWidth - 20;
            const HEIGHT = H;
            const STEP = HEIGHT / 10;
            for (let i = 0; i <= 10; i++) {
                const y = BOTTOM_Y - i * STEP;
                const line = document.createElementNS(ns, 'line');
                line.setAttribute('x1', '50');
                line.setAttribute('x2', String(right));
                line.setAttribute('y1', String(y));
                line.setAttribute('y2', String(y));
                line.setAttribute('class', 'grid-line');
                chartEl.appendChild(line);
                const label = document.createElementNS(ns, 'text');
                label.setAttribute('x', '30');
                label.setAttribute('y', String(y + 4));
                label.setAttribute('class', 'grid-label');
                label.textContent = String(i * 10);
                chartEl.appendChild(label);
            }
            const t = document.createElementNS(ns, 'text');
            t.setAttribute('x', String(chartWidth / 2));
            t.setAttribute('y', '20');
            t.setAttribute('class', 'grid-label');
            t.setAttribute('text-anchor', 'middle');
            t.textContent = title;
            chartEl.appendChild(t);
            chartEl.__gridDrawn = true;
        }
        let barsGroup = chartEl.__barsGroup;
        if (!barsGroup) {
            barsGroup = document.createElementNS(ns, 'g');
            chartEl.appendChild(barsGroup);
            chartEl.__barsGroup = barsGroup;
        }
        while (barsGroup.firstChild) barsGroup.removeChild(barsGroup.firstChild);
        const chartWidth = chartEl.getBoundingClientRect().width;
        const left = 60,
            right = chartWidth - 20,
            width = right - left;
        const slot = width / 10;
        const gap = 8;
        const barW = Math.max(4, slot - gap);
        for (let t = 0; t <= 9; t++) {
            const v = values[t];
            const pct = total > 0 ? (v / total) * 100 : 0;
            const h = (pct / 100) * H;
            const x = left + t * slot + gap / 2;
            const y = BOTTOM_Y - h;
            const rect = document.createElementNS(ns, 'rect');
            rect.setAttribute('x', String(x));
            rect.setAttribute('y', String(y));
            rect.setAttribute('width', String(barW));
            rect.setAttribute('height', String(h));
            rect.setAttribute('rx', '3');
            rect.setAttribute('ry', '3');
            rect.setAttribute('class', title === 'Over' ? 'bar-rect-odd' : 'bar-rect-even');
            barsGroup.appendChild(rect);
            const label = document.createElementNS(ns, 'text');
            const xCenter = x + barW / 2;
            const dx = t % 2 === 0 ? -8 : 8;
            label.setAttribute('x', String(xCenter + dx));
            label.setAttribute('y', String(Math.max(TOP_Y + 10, y - 5)));
            label.setAttribute('class', 'bar-perc');
            label.style.fontSize = '10px';
            label.textContent = `${pct.toFixed(1)}%`;
            barsGroup.appendChild(label);
            const tickLabel = document.createElementNS(ns, 'text');
            tickLabel.setAttribute('x', String(x + barW / 2));
            tickLabel.setAttribute('y', '245');
            tickLabel.setAttribute('class', 'grid-label');
            tickLabel.setAttribute('text-anchor', 'middle');
            tickLabel.textContent = String(t);
            barsGroup.appendChild(tickLabel);
        }
    }
    const overVals = new Array(10).fill(0);
    for (let t = 0; t <= 9; t++) overVals[t] = t < 9 ? total - prefix[t] : 0;
    const underVals = new Array(10).fill(0);
    for (let t = 0; t <= 9; t++) underVals[t] = t > 0 ? prefix[t - 1] : 0;
    renderSeries(ouOverChart, overVals, 'Over');
    renderSeries(ouUnderChart, underVals, 'Under');
}
function updateMatchDiffer() {
    const target = parseInt(mdInput && mdInput.value, 10);
    if (!Number.isFinite(target)) return;
    let match = 0,
        differ = 0;
    for (let i = 0; i < digitsQueue.length; i++) {
        const v = digitsQueue[i];
        if (v === target) match++;
        else differ++;
    }
    const total = Math.max(digitsQueue.length, 1);
    const mPct = (match / total) * 100;
    const dPct = (differ / total) * 100;
    if (mdSummary) mdSummary.textContent = `Match: ${mPct.toFixed(1)}% | Differ: ${dPct.toFixed(1)}%`;
    drawMdHistGridOnce();
    if (mdHistChart) {
        const ns = 'http://www.w3.org/2000/svg';
        const counts = new Array(10).fill(0);
        for (let i = 0; i < digitsQueue.length; i++) counts[digitsQueue[i]]++;
        const total = Math.max(digitsQueue.length, 1);
        let barsGroup = mdHistChart.__barsGroup;
        if (!barsGroup) {
            barsGroup = document.createElementNS(ns, 'g');
            mdHistChart.appendChild(barsGroup);
            mdHistChart.__barsGroup = barsGroup;
        }
        while (barsGroup.firstChild) barsGroup.removeChild(barsGroup.firstChild);
        const TOP_Y = 10,
            BOTTOM_Y = 250;
        const SCALE_MAX = 20;
        const left = 60,
            right = 380,
            width = right - left;
        const slot = width / 10;
        const gap = 10;
        const barW = Math.max(6, slot - gap);
        for (let d = 0; d <= 9; d++) {
            const pct = (counts[d] / total) * 100;
            const h = (Math.min(pct, SCALE_MAX) / SCALE_MAX) * (BOTTOM_Y - TOP_Y);
            const x = left + d * slot + gap / 2;
            const y = BOTTOM_Y - h;
            const rect = document.createElementNS(ns, 'rect');
            rect.setAttribute('x', String(x));
            rect.setAttribute('y', String(y));
            rect.setAttribute('width', String(barW));
            rect.setAttribute('height', String(h));
            rect.setAttribute('rx', '4');
            rect.setAttribute('ry', '4');
            const isMatchBar = Number.isFinite(target) && d === target;
            rect.setAttribute('class', isMatchBar ? 'bar-rect-even' : 'bar-rect-odd');
            barsGroup.appendChild(rect);
            const label = document.createElementNS(ns, 'text');
            const xCenter = x + barW / 2;
            const dx = d % 2 === 0 ? -10 : 10;
            label.setAttribute('x', String(xCenter + dx));
            label.setAttribute('y', String(Math.max(TOP_Y + 12, y - 6)));
            label.setAttribute('class', 'bar-perc');
            label.textContent = `${pct.toFixed(2)}%`;
            barsGroup.appendChild(label);
            const tick = document.createElementNS(ns, 'text');
            tick.setAttribute('x', String(x + barW / 2));
            tick.setAttribute('y', '245');
            tick.setAttribute('class', 'grid-label');
            tick.setAttribute('text-anchor', 'middle');
            tick.textContent = String(d);
            barsGroup.appendChild(tick);
        }
    }
}
function updateRiseFall() {
    let rise = 0,
        equal = 0,
        fall = 0;
    for (let i = 1; i < digitsQueue.length; i++) {
        const prev = digitsQueue[i - 1];
        const cur = digitsQueue[i];
        if (cur > prev) rise++;
        else if (cur < prev) fall++;
        else equal++;
    }
    const totalPairs = Math.max(digitsQueue.length - 1, 1);
    const rPct = (rise / totalPairs) * 100;
    const ePct = (equal / totalPairs) * 100;
    const fPct = (fall / totalPairs) * 100;
    drawRfGridOnce();
    if (rfRiseRect && rfEqualRect && rfFallRect && rfRiseText && rfEqualText && rfFallText) {
        const TOP_Y = 10,
            BOTTOM_Y = 250,
            H = BOTTOM_Y - TOP_Y;
        const rh = (rPct / 100) * H;
        const eh = (ePct / 100) * H;
        const fh = (fPct / 100) * H;
        rfRiseRect.setAttribute('y', String(BOTTOM_Y - rh));
        rfRiseRect.setAttribute('height', String(rh));
        rfEqualRect.setAttribute('y', String(BOTTOM_Y - eh));
        rfEqualRect.setAttribute('height', String(eh));
        rfFallRect.setAttribute('y', String(BOTTOM_Y - fh));
        rfFallRect.setAttribute('height', String(fh));
        rfRiseText.textContent = `${rPct.toFixed(2)}%`;
        rfEqualText.textContent = `${ePct.toFixed(2)}%`;
        rfFallText.textContent = `${fPct.toFixed(2)}%`;
        rfRiseText.setAttribute('y', String(BOTTOM_Y - rh - 6));
        rfEqualText.setAttribute('y', String(BOTTOM_Y - eh - 6));
        rfFallText.setAttribute('y', String(BOTTOM_Y - fh - 6));
    }
    if (rfChipsEl && digitsQueue.length >= 2) {
        const prev = digitsQueue[digitsQueue.length - 2];
        const cur = digitsQueue[digitsQueue.length - 1];
        const chip = document.createElement('span');
        let cls = 'eq';
        if (cur > prev) cls = 'u';
        else if (cur < prev) cls = 'ov';
        chip.className = `chip ${cls}`;
        rfChipsEl.appendChild(chip);
        while (rfChipsEl.children.length > 30) rfChipsEl.removeChild(rfChipsEl.firstChild);
    }
    const rfRisePercentageEl = document.getElementById('rf-rise-percentage');
    const rfEqualPercentageEl = document.getElementById('rf-equal-percentage');
    const rfFallPercentageEl = document.getElementById('rf-fall-percentage');
    if (rfRisePercentageEl) rfRisePercentageEl.textContent = `${rPct.toFixed(2)}%`;
    if (rfEqualPercentageEl) rfEqualPercentageEl.textContent = `${ePct.toFixed(2)}%`;
    if (rfFallPercentageEl) rfFallPercentageEl.textContent = `${fPct.toFixed(2)}%`;
}
function connect() {
    ws = new WebSocket(ENDPOINT);
    if (wsStatusEl) {
        wsStatusEl.textContent = 'Connecting';
        wsStatusEl.className = 'status';
    }
    ws.onopen = () => {
        if (wsStatusEl) {
            wsStatusEl.textContent = 'Connected';
            wsStatusEl.className = 'status ok';
        }
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
        if (currentSymbol) {
            ws.send(
                JSON.stringify({
                    ticks_history: currentSymbol,
                    adjust_start_time: 1,
                    count: MAX_SAMPLES,
                    end: 'latest',
                    start: 1,
                    style: 'ticks',
                })
            );
            ws.send(JSON.stringify({ ticks: currentSymbol, subscribe: 1 }));
        }
    };
    ws.onmessage = msg => {
        const data = JSON.parse(msg.data);
        if (data.active_symbols) {
            const vols = data.active_symbols.filter(
                s => s.market === 'synthetic_index' && /Volatility/i.test(s.display_name)
            );
            symbolMeta.clear();
            vols.forEach(s => {
                const pip = Number(s.pip ?? s.pip_size ?? 0.01);
                let decimals = 0;
                if (Number.isFinite(pip)) {
                    const str = String(pip);
                    if (str.includes('.')) decimals = str.split('.')[1].length;
                }
                symbolMeta.set(s.symbol, { decimals });
            });
            if (symbolsEl) {
                symbolsEl.innerHTML = '';
                const oneS = vols.filter(s => /(1s)/i.test(s.display_name) || /_1s$/i.test(s.symbol));
                const std = vols.filter(s => !oneS.includes(s));
                const addGroup = (label, arr) => {
                    if (!arr.length) return;
                    const grp = document.createElement('optgroup');
                    grp.label = label;
                    arr.forEach(s => {
                        const opt = document.createElement('option');
                        opt.value = s.symbol;
                        opt.textContent = s.display_name;
                        grp.appendChild(opt);
                    });
                    symbolsEl.appendChild(grp);
                };
                addGroup('Volatility (1s)', oneS);
                addGroup('Volatility', std);
                const want =
                    currentSymbol && vols.some(s => s.symbol === currentSymbol)
                        ? currentSymbol
                        : vols[0]?.symbol || null;
                if (want) {
                    symbolsEl.value = want;
                    subscribe(want);
                }
            }
        }
        if (data.history && data.history.prices && Array.isArray(data.history.prices)) {
            currentPipSize = Number(data.history.pip_size ?? currentPipSize ?? 2);
            resetStats();
            data.history.prices.forEach(q => {
                const meta = symbolMeta.get(currentSymbol);
                const decimalsOverride = meta?.decimals ?? null;
                const lastDigit = extractLastDigit(q, decimalsOverride ?? currentPipSize);
                pushDigit(lastDigit);
            });
            updateOverUnder();
            updateMatchDiffer();
            updateRiseFall();
        }
        if (data.tick) {
            const { quote, symbol } = data.tick;
            currentPipSize = Number(data.tick.pip_size ?? currentPipSize ?? 2);
            if (symbol === currentSymbol) {
                const meta = symbolMeta.get(currentSymbol);
                const decimalsOverride = meta?.decimals ?? null;
                const usedDecimals = decimalsOverride ?? currentPipSize;
                const lastDigit = extractLastDigit(quote, usedDecimals);
                if (livePriceEl) livePriceEl.textContent = toFixedWithPip(quote, usedDecimals);
                if (eoChipsEl) {
                    const chip = document.createElement('span');
                    chip.className = `chip ${lastDigit % 2 === 0 ? 'e' : 'o'}`;
                    eoChipsEl.appendChild(chip);
                    while (eoChipsEl.children.length > 30) eoChipsEl.removeChild(eoChipsEl.firstChild);
                }
                if (mdChipsEl && mdInput) {
                    const target = parseInt(mdInput.value, 10);
                    const chip = document.createElement('span');
                    const isMatch = Number.isFinite(target) && lastDigit === target;
                    chip.className = `chip ${isMatch ? 'e' : 'o'}`;
                    mdChipsEl.appendChild(chip);
                    while (mdChipsEl.children.length > 30) mdChipsEl.removeChild(mdChipsEl.firstChild);
                }
                if (ouChipsEl && ouInput) {
                    const thr = parseInt(ouInput.value, 10);
                    let cls = 'eq';
                    if (Number.isFinite(thr)) {
                        if (lastDigit < thr) cls = 'u';
                        else if (lastDigit > thr) cls = 'ov';
                        else cls = 'eq';
                    }
                    const chip2 = document.createElement('span');
                    chip2.className = `chip ${cls}`;
                    ouChipsEl.appendChild(chip2);
                    while (ouChipsEl.children.length > 30) ouChipsEl.removeChild(ouChipsEl.firstChild);
                }
                pushDigit(lastDigit);
                updateOverUnder();
                updateMatchDiffer();
                updateRiseFall();
            }
        }
        if (data.error) {
            console.error('Deriv error:', data.error);
            if (wsStatusEl) {
                wsStatusEl.textContent = `API error: ${data.error.code || ''} ${data.error.message || ''}`;
                wsStatusEl.className = 'status error';
            }
        }
    };
    ws.onerror = () => {
        if (wsStatusEl) {
            wsStatusEl.textContent = 'Socket error (will retry)';
            wsStatusEl.className = 'status error';
        }
    };
    ws.onclose = () => {
        if (wsStatusEl) {
            wsStatusEl.textContent = 'Disconnected (retrying)';
            wsStatusEl.className = 'status';
        }
        setTimeout(connect, 1500);
    };
}
function subscribe(symbol) {
    if (!symbol || currentSymbol === symbol) return;
    currentSymbol = symbol;
    resetStats();
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ forget_all: 'ticks' }));
        ws.send(
            JSON.stringify({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: MAX_SAMPLES,
                end: 'latest',
                start: 1,
                style: 'ticks',
            })
        );
        ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    }
}
if (symbolsEl) symbolsEl.addEventListener('change', e => subscribe(e.target.value));
if (ticksWindowEl) {
    const v = parseInt(ticksWindowEl.value, 10);
    if (Number.isFinite(v)) MAX_SAMPLES = Math.max(50, Math.min(5000, v));
    ticksWindowEl.value = String(MAX_SAMPLES);
    ticksWindowEl.addEventListener('change', () => {
        let val = parseInt(ticksWindowEl.value, 10);
        if (!Number.isFinite(val)) val = 1000;
        val = Math.max(50, Math.min(5000, val));
        ticksWindowEl.value = String(val);
        MAX_SAMPLES = val;
        resetStats();
        if (currentSymbol && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ forget_all: 'ticks' }));
            ws.send(
                JSON.stringify({
                    ticks_history: currentSymbol,
                    adjust_start_time: 1,
                    count: MAX_SAMPLES,
                    end: 'latest',
                    start: 1,
                    style: 'ticks',
                })
            );
            ws.send(JSON.stringify({ ticks: currentSymbol, subscribe: 1 }));
        }
    });
}
if (ouInput) {
    ouInput.addEventListener('change', () => {
        let v = parseInt(ouInput.value, 10);
        if (!Number.isFinite(v)) v = 5;
        v = Math.max(0, Math.min(9, v));
        ouInput.value = String(v);
        updateOverUnder();
    });
}
if (mdInput) {
    mdInput.addEventListener('change', () => {
        let v = parseInt(mdInput.value, 10);
        if (!Number.isFinite(v)) v = 5;
        v = Math.max(0, Math.min(9, v));
        mdInput.value = String(v);
        updateMatchDiffer();
    });
}
function toggleMobileMenu() {
    if (sidebar && mobileOverlay) {
        const isOpen = !sidebar.classList.contains('-translate-x-full');
        if (isOpen) {
            sidebar.classList.add('-translate-x-full');
            mobileOverlay.classList.add('hidden');
        } else {
            sidebar.classList.remove('-translate-x-full');
            mobileOverlay.classList.remove('hidden');
        }
    }
}
function closeMobileMenu() {
    if (sidebar && mobileOverlay) {
        sidebar.classList.add('-translate-x-full');
        mobileOverlay.classList.add('hidden');
    }
}
if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', toggleMobileMenu);
}
if (mobileOverlay) {
    mobileOverlay.addEventListener('click', closeMobileMenu);
}
const analysisButtons = [tabEo, tabOu, tabMd, tabRf];
analysisButtons.forEach(button => {
    if (button) {
        button.addEventListener('click', () => {
            setTimeout(closeMobileMenu, 100);
        });
    }
});
window.addEventListener('resize', () => {
    if (window.innerWidth >= 768) {
        closeMobileMenu();
    }
    updateOverUnder();
    updateMatchDiffer();
});
connect();

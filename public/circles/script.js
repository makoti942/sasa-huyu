// DISABLED - replaced by DerivAuth.js
// const ENDPOINT = 'wss://ws.derivws.com/websockets/v3?app_id=107255';
let ws = null;
let currentSymbol = null;
let activeSymbols = [];
const symbolMeta = new Map(); // symbol -> { decimals }
let currentPipSize = null; // provided by API per symbol
const CIRCLES_SYMBOL_KEY = 'circles.selected_symbol.v1';

// Maintain rolling last 1000 tick digits for the subscribed symbol
let MAX_SAMPLES = 1000; // dynamic window
let digitsQueue = [];
let freq = Array.from({ length: 10 }, () => 0);

const symbolsEl = document.getElementById('symbols');
const priceEl = document.getElementById('price');
const digitEl = document.getElementById('digit');
const digitsContainer = document.getElementById('digits');
const samplesCountEl = document.getElementById('samples-count');
const ticksWindowEl = document.getElementById('ticks-window');
const ouThresholdEl = document.getElementById('ou-threshold');
const ouUnderPctEl = document.getElementById('ou-under-pct');
const ouEqualPctEl = document.getElementById('ou-equal-pct');
const ouOverPctEl = document.getElementById('ou-over-pct');
const ouUnderFillEl = document.getElementById('ou-under-fill');
const ouEqualFillEl = document.getElementById('ou-equal-fill');
const ouOverFillEl = document.getElementById('ou-over-fill');
const ouSeqChipsEl = document.getElementById('ou-seq-chips');
const ouMoreBtn = document.getElementById('ou-more');
let ouShowCount = 10; // 10 or 50

// Matches/Differs elements
const mdMatchPctEl = document.getElementById('md-match-pct');
const mdDifferPctEl = document.getElementById('md-differ-pct');
const mdMatchFillEl = document.getElementById('md-match-fill');
const mdDifferFillEl = document.getElementById('md-differ-fill');
const mdSeqChipsEl = document.getElementById('md-seq-chips');
const mdMoreBtn = document.getElementById('md-more');
let mdShowCount = 10;

// Even/Odd elements
const eoEvenPctEl = document.getElementById('eo-even-pct');
const eoOddPctEl = document.getElementById('eo-odd-pct');
const eoEvenFillEl = document.getElementById('eo-even-fill');
const eoOddFillEl = document.getElementById('eo-odd-fill');
const eoSeqChipsEl = document.getElementById('eo-seq-chips');
const eoMoreBtn = document.getElementById('eo-more');
let eoShowCount = 50; // Show all 50 by default

const appTitleEl = document.getElementById('app-title');
const labelMarketEl = document.getElementById('label-market');
const labelWindowEl = document.getElementById('label-window');
const digitsTitleEl = document.getElementById('digits-title');
const legendCurrentEl = document.getElementById('legend-current');
const legendLeastEl = document.getElementById('legend-least');
const labelOuEl = document.getElementById('label-ou');

// Obfuscated title injection: keep the phrase out of static HTML
(function secureTitle() {
    try {
        // Build title from char codes to avoid plain-text presence
        const codes = [88, 101, 110, 111, 110, 32, 84, 105, 99, 107, 32, 65, 110, 97, 108, 121, 115, 101, 114];
        const title = String.fromCharCode.apply(null, codes);
        if (appTitleEl) appTitleEl.textContent = title;
        document.title = title;

        // Guard: restore if mutated
        const restore = () => {
            if (document.title !== title) document.title = title;
            if (appTitleEl && appTitleEl.textContent !== title) appTitleEl.textContent = title;
        };

        // Observe DOM mutations on the title element
        if (appTitleEl && window.MutationObserver) {
            const mo = new MutationObserver(restore);
            mo.observe(appTitleEl, { childList: true, characterData: true, subtree: true });
        }

        // Trap document.title setter to enforce our title
        try {
            const desc =
                Object.getOwnPropertyDescriptor(Document.prototype, 'title') ||
                Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'title');
            if (desc && desc.set) {
                const nativeSetter = desc.set.bind(document);
                Object.defineProperty(document, 'title', {
                    configurable: false,
                    enumerable: true,
                    get: desc.get ? desc.get.bind(document) : () => title,
                    set: v => {
                        requestAnimationFrame(restore);
                        return nativeSetter(title);
                    },
                });
            } else {
                // Fallback periodic restore
                setInterval(restore, 2000);
            }
        } catch (_) {
            setInterval(restore, 2000);
        }
    } catch (_) {}
})();

// Lock critical headings/labels against edits and keep text out of static HTML
(function secureHeadings() {
    const restoreText = (el, target) => {
        if (el && el.textContent !== target) el.textContent = target;
    };
    const fromCodes = arr => String.fromCharCode.apply(null, arr);

    const strings = {
        labelMarket: fromCodes([83, 101, 108, 101, 99, 116, 32, 77, 97, 114, 107, 101, 116, 58]), // "Select Market:"
        labelWindow: fromCodes([84, 105, 99, 107, 115, 32, 119, 105, 110, 100, 111, 119, 58]), // "Ticks window:"
        digitsTitle:
            fromCodes([76, 97, 115, 116, 32]) +
            MAX_SAMPLES +
            fromCodes([
                32, 116, 105, 99, 107, 115, 32, 100, 105, 103, 105, 116, 32, 100, 105, 115, 116, 114, 105, 98, 117, 116,
                105, 111, 110,
            ]),
        legendCurrent: fromCodes([
            99, 117, 114, 114, 101, 110, 116, 32, 100, 105, 103, 105, 116, 32, 47, 32, 109, 111, 115, 116,
        ]),
        legendLeast: fromCodes([108, 101, 97, 115, 116, 32, 102, 114, 101, 113, 117, 101, 110, 99, 121]),
        labelOu: fromCodes([79, 118, 101, 114, 47, 85, 110, 100, 101, 114, 58]),
    };

    function applyAll() {
        restoreText(labelMarketEl, strings.labelMarket);
        restoreText(labelWindowEl, strings.labelWindow);
        restoreText(digitsTitleEl, `Last ${MAX_SAMPLES} ticks digit distribution`);
        restoreText(legendCurrentEl, strings.legendCurrent);
        restoreText(legendLeastEl, strings.legendLeast);
        restoreText(labelOuEl, strings.labelOu);
    }

    applyAll();

    const mo = window.MutationObserver ? new MutationObserver(applyAll) : null;
    if (mo) {
        [labelMarketEl, labelWindowEl, digitsTitleEl, legendCurrentEl, legendLeastEl, labelOuEl]
            .filter(Boolean)
            .forEach(el => mo.observe(el, { childList: true, characterData: true, subtree: true }));
    }

    // Ensure dynamic window changes also update the heading consistently
    const origUpdateSamples = updateSamplesCount;
    updateSamplesCount = function () {
        origUpdateSamples();
        restoreText(digitsTitleEl, `Last ${MAX_SAMPLES} ticks digit distribution`);
    };
})();

// Mirror theme from parent app (dark/light)
(function mirrorTheme() {
    const root = document.documentElement;

    const isParentDark = () => {
        try {
            // Check common places the main app might store theme
            const pdoc = window.parent && window.parent.document;
            if (!pdoc || pdoc === document) return null;
            const pel = pdoc.documentElement;
            if (pel.classList.contains('dark')) return true;
            if (pel.getAttribute('data-theme') === 'dark') return true;
            const pbody = pdoc.body;
            if (pbody && (pbody.classList.contains('dark') || pbody.getAttribute('data-theme') === 'dark')) return true;
            return false;
        } catch (_) {
            return null; // cross-origin; fall back to media
        }
    };

    const applyDark = isDark => {
        if (typeof isDark !== 'boolean') return;
        root.classList.toggle('dark', isDark);
    };

    // Initial set
    const initial = isParentDark();
    if (initial === null) {
        // Fallback: system preference
        applyDark(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } else {
        applyDark(initial);
    }

    // Listen for parent theme messages
    window.addEventListener('message', e => {
        try {
            const d = e.data;
            if (d && typeof d === 'object' && d.type === 'theme' && 'isDark' in d) {
                applyDark(!!d.isDark);
            }
        } catch (_) {}
    });

    // Observe parent <html> class changes when same-origin
    try {
        const pdoc = window.parent && window.parent.document;
        if (pdoc && pdoc !== document && window.parent.MutationObserver) {
            const pel = pdoc.documentElement;
            const sync = () => applyDark(pel.classList.contains('dark') || pel.getAttribute('data-theme') === 'dark');
            const mo = new window.parent.MutationObserver(sync);
            mo.observe(pel, { attributes: true, attributeFilter: ['class', 'data-theme'] });
            sync();
        }
    } catch (_) {
        // Ignore cross-origin
    }

    // Periodic fallback sync (covers edge cases)
    setInterval(() => {
        const v = isParentDark();
        if (v !== null) applyDark(v);
    }, 2000);
})();

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

function initDigitUI() {
    digitsContainer.innerHTML = '';
    for (let d = 0; d < 10; d++) {
        const row = document.createElement('div');
        row.className = 'digit-item';

        const circle = document.createElement('div');
        circle.className = 'circle';
        circle.dataset.digit = String(d);
        const content = document.createElement('div');
        content.className = 'circle-content';
        const num = document.createElement('div');
        num.className = 'circle-num';
        num.textContent = String(d);
        const pct = document.createElement('div');
        pct.className = 'circle-pct';
        pct.textContent = '0%';
        content.appendChild(num);
        content.appendChild(pct);
        circle.appendChild(content);

        // clicking a digit circle sets O/U threshold to that digit
        circle.addEventListener('click', () => {
            ouThresholdEl.value = String(d);
            updateOverUnder();
        });

        row.appendChild(circle);
        digitsContainer.appendChild(row);
    }
}

function updateSamplesCount() {
    samplesCountEl.textContent = `${digitsQueue.length}/${MAX_SAMPLES}`;
}

function recalcAndRender() {
    // find top/second-most and least/second-least frequencies
    let maxFreq = 0;
    let secondFreq = 0;
    let minFreq = Number.POSITIVE_INFINITY;
    let secondMin = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 10; i++) {
        if (freq[i] > maxFreq) {
            secondFreq = maxFreq;
            maxFreq = freq[i];
        } else if (freq[i] > secondFreq && freq[i] < maxFreq) {
            secondFreq = freq[i];
        }
        if (digitsQueue.length > 0) minFreq = Math.min(minFreq, freq[i]);
    }

    if (digitsQueue.length > 0) {
        for (let i = 0; i < 10; i++) {
            if (freq[i] > minFreq && freq[i] < secondMin) secondMin = freq[i];
        }
        if (!Number.isFinite(secondMin)) secondMin = 0; // no second-least when all equal
    }

    // current digit highlight
    const currentDigit = digitsQueue.length ? digitsQueue[digitsQueue.length - 1] : null;

    for (let d = 0; d < 10; d++) {
        const row = digitsContainer.children[d];
        const circle = row.querySelector('.circle');
        const percent = row.querySelector('.circle-pct');

        const p = digitsQueue.length ? (freq[d] / digitsQueue.length) * 100 : 0;
        percent.textContent = `${p.toFixed(1)}%`;
        circle.style.setProperty('--pct', p);

        circle.classList.toggle('current', currentDigit === d);
        circle.classList.toggle('top', maxFreq > 0 && freq[d] === maxFreq);
        circle.classList.toggle('second', secondFreq > 0 && freq[d] === secondFreq);
        circle.classList.toggle('least', digitsQueue.length > 0 && freq[d] === minFreq);
        circle.classList.toggle('secondleast', secondMin > 0 && freq[d] === secondMin);
    }

    updateSamplesCount();
    updateOverUnder();
    updateMatchesDiffers();
    updateEvenOdd();
}

function resetStats() {
    digitsQueue = [];
    freq = Array.from({ length: 10 }, () => 0);
    recalcAndRender();
}

function pushDigit(d) {
    digitsQueue.push(d);
    freq[d]++;
    if (digitsQueue.length > MAX_SAMPLES) {
        const removed = digitsQueue.shift();
        freq[removed]--;
    }
    recalcAndRender();
}

function connect() {
    ws = new WebSocket(ENDPOINT);

    ws.onopen = () => {
        ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
        if (currentSymbol) {
            // fetch historical ticks to seed the distribution
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
            // Keep only Volatility Indices (exclude Crash/Boom, Step, etc.)
            const vols = data.active_symbols.filter(
                s => s.market === 'synthetic_index' && /Volatility/i.test(s.display_name)
            );

            // gather decimals from pip if present
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

            // Build optgroups: (1s) first, then standard
            const oneS = vols.filter(s => /(1s)/i.test(s.display_name) || /_1s$/i.test(s.symbol));
            const std = vols.filter(s => !oneS.includes(s));

            symbolsEl.innerHTML = '';
            if (oneS.length) {
                const grp = document.createElement('optgroup');
                grp.label = 'Volatility (1s)';
                oneS.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.symbol;
                    opt.textContent = s.display_name;
                    grp.appendChild(opt);
                });
                symbolsEl.appendChild(grp);
            }
            if (std.length) {
                const grp = document.createElement('optgroup');
                grp.label = 'Volatility';
                std.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.symbol;
                    opt.textContent = s.display_name;
                    grp.appendChild(opt);
                });
                symbolsEl.appendChild(grp);
            }
            // Restore previously selected symbol if available and valid
            try {
                const saved = window.localStorage.getItem(CIRCLES_SYMBOL_KEY);
                const allSymbols = vols.map(s => s.symbol);
                if (saved && allSymbols.includes(saved)) {
                    subscribe(saved);
                } else if (!currentSymbol && vols.length > 0) {
                    subscribe(vols[0].symbol);
                }
            } catch (_) {
                if (!currentSymbol && vols.length > 0) subscribe(vols[0].symbol);
            }
        }

        // Seed history
        if (data.history && data.history.prices && Array.isArray(data.history.prices)) {
            currentPipSize = Number(data.history.pip_size ?? currentPipSize ?? 2);
            resetStats();
            data.history.prices.forEach(q => {
                const meta = symbolMeta.get(currentSymbol);
                const decimalsOverride = meta?.decimals ?? null;
                const lastDigit = extractLastDigit(q, decimalsOverride ?? currentPipSize);
                pushDigit(lastDigit);
            });
        }

        // Live ticks
        if (data.tick) {
            const { quote, symbol } = data.tick;
            currentPipSize = Number(data.tick.pip_size ?? currentPipSize ?? 2);
            if (symbol === currentSymbol) {
                const meta = symbolMeta.get(currentSymbol);
                const decimalsOverride = meta?.decimals ?? null;
                const usedDecimals = decimalsOverride ?? currentPipSize;
                priceEl.textContent = toFixedWithPip(quote, usedDecimals);
                const lastDigit = extractLastDigit(quote, usedDecimals);
                digitEl.textContent = String(lastDigit);
                pushDigit(lastDigit);
            }
        }

        // Errors
        if (data.error) {
            console.error('Deriv error:', data.error);
        }
    };

    ws.onclose = () => {
        setTimeout(connect, 1500);
    };
}

function subscribe(symbol) {
    if (!symbol) return;
    if (currentSymbol === symbol) return;
    currentSymbol = symbol;
    try {
        window.localStorage.setItem(CIRCLES_SYMBOL_KEY, symbol);
    } catch (_) {}
    if (symbolsEl && symbolsEl.value !== symbol) {
        symbolsEl.value = symbol;
    }

    resetStats();

    if (ws && ws.readyState === WebSocket.OPEN) {
        // stop all previous subscriptions by id is more reliable, but here we just forget by symbol name
        ws.send(JSON.stringify({ forget_all: 'ticks' }));

        // seed history then subscribe live
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

symbolsEl.addEventListener('change', e => {
    subscribe(e.target.value);
});

initDigitUI();
connect();

// Handle dynamic window changes
ticksWindowEl.addEventListener('change', () => {
    let val = parseInt(ticksWindowEl.value, 10);
    if (!Number.isFinite(val)) val = 1000;
    val = Math.max(50, Math.min(5000, val));
    ticksWindowEl.value = String(val);
    MAX_SAMPLES = val;
    document.querySelector('.digits-header span').textContent = `Last ${MAX_SAMPLES} ticks digit distribution`;
    // reseed for current symbol
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
    // also refresh dependent summaries
    updateOverUnder();
    updateMatchesDiffers();
    updateEvenOdd();
});

// Over/Under setup
function initOverUnder() {
    ouThresholdEl.innerHTML = '';
    for (let i = 0; i <= 9; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = String(i);
        ouThresholdEl.appendChild(opt);
    }
    ouThresholdEl.value = '5';
    ouThresholdEl.addEventListener('change', () => {
        updateOverUnder();
        updateMatchesDiffers();
    });
}

function updateOverUnder() {
    const threshold = parseInt(ouThresholdEl.value, 10);
    if (!Number.isFinite(threshold)) return;

    // compute distribution under/equal/over across the current window
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
    // Only show percentages, no count numbers
    ouUnderPctEl.textContent = `${((under / total) * 100).toFixed(1)}%`;
    ouEqualPctEl.textContent = `${((equal / total) * 100).toFixed(1)}%`;
    ouOverPctEl.textContent = `${((over / total) * 100).toFixed(1)}%`;

    // Update bar widths
    const uPct = (under / total) * 100;
    const ePct = (equal / total) * 100;
    const oPct = (over / total) * 100;
    if (ouUnderFillEl) ouUnderFillEl.style.width = `${uPct.toFixed(1)}%`;
    if (ouEqualFillEl) ouEqualFillEl.style.width = `${ePct.toFixed(1)}%`;
    if (ouOverFillEl) ouOverFillEl.style.width = `${oPct.toFixed(1)}%`;

    // Render recent sequence chips (newest on right)
    if (ouSeqChipsEl) {
        const n = Math.min(ouShowCount, digitsQueue.length);
        const thresholdNow = threshold;
        ouSeqChipsEl.innerHTML = '';
        for (let i = digitsQueue.length - n; i < digitsQueue.length; i++) {
            if (i < 0) continue;
            const v = digitsQueue[i];
            const chip = document.createElement('div');
            let cls = 'equal';
            let text = '=';
            if (v < thresholdNow) {
                cls = 'under';
                text = 'U';
            } else if (v > thresholdNow) {
                cls = 'over';
                text = 'O';
            }
            chip.className = `ou-chip ${cls}`;
            chip.textContent = text;
            ouSeqChipsEl.appendChild(chip);
        }
    }
}

// Toggle show more/less for sequence
if (ouMoreBtn) {
    ouMoreBtn.addEventListener('click', () => {
        ouShowCount = ouShowCount === 10 ? 50 : 10;
        ouMoreBtn.textContent = ouShowCount === 10 ? 'More' : 'Less';
        updateOverUnder();
    });
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
    // Only show percentages, no count numbers
    if (eoEvenPctEl) eoEvenPctEl.textContent = `${((even / total) * 100).toFixed(1)}%`;
    if (eoOddPctEl) eoOddPctEl.textContent = `${((odd / total) * 100).toFixed(1)}%`;
    if (eoEvenFillEl) eoEvenFillEl.style.width = `${((even / total) * 100).toFixed(1)}%`;
    if (eoOddFillEl) eoOddFillEl.style.width = `${((odd / total) * 100).toFixed(1)}%`;

    if (eoSeqChipsEl) {
        const n = Math.min(eoShowCount, digitsQueue.length);
        eoSeqChipsEl.innerHTML = '';
        for (let i = digitsQueue.length - n; i < digitsQueue.length; i++) {
            if (i < 0) continue;
            const v = digitsQueue[i];
            const chip = document.createElement('div');
            const isEven = v % 2 === 0;
            chip.className = `eo-chip ${isEven ? 'even' : 'odd'}`;
            chip.textContent = isEven ? 'E' : 'O';
            eoSeqChipsEl.appendChild(chip);
        }
    }
}

// E/O More button removed - showing all 50 by default
// if (eoMoreBtn) {
//   eoMoreBtn.addEventListener("click", () => {
//     eoShowCount = eoShowCount === 10 ? 50 : 10;
//     eoMoreBtn.textContent = eoShowCount === 10 ? "More" : "Less";
//     updateEvenOdd();
//   });
// }

function updateMatchesDiffers() {
    // Selected digit for match vs differ is the threshold selector's value itself
    const selectedDigit = parseInt(ouThresholdEl.value, 10);
    if (!Number.isFinite(selectedDigit)) return;

    let match = 0,
        differ = 0;
    for (let i = 0; i < digitsQueue.length; i++) {
        const v = digitsQueue[i];
        if (v === selectedDigit) match++;
        else differ++;
    }
    const total = Math.max(digitsQueue.length, 1);
    // Only show percentages, no count numbers
    if (mdMatchPctEl) mdMatchPctEl.textContent = `${((match / total) * 100).toFixed(1)}%`;
    if (mdDifferPctEl) mdDifferPctEl.textContent = `${((differ / total) * 100).toFixed(1)}%`;
    if (mdMatchFillEl) mdMatchFillEl.style.width = `${((match / total) * 100).toFixed(1)}%`;
    if (mdDifferFillEl) mdDifferFillEl.style.width = `${((differ / total) * 100).toFixed(1)}%`;

    // Render sequence of last mdShowCount as M or D, newest on right
    if (mdSeqChipsEl) {
        const n = Math.min(mdShowCount, digitsQueue.length);
        mdSeqChipsEl.innerHTML = '';
        for (let i = digitsQueue.length - n; i < digitsQueue.length; i++) {
            if (i < 0) continue;
            const v = digitsQueue[i];
            const chip = document.createElement('div');
            const isMatch = v === selectedDigit;
            chip.className = `md-chip ${isMatch ? 'match' : 'differ'}`;
            chip.textContent = isMatch ? 'M' : 'D';
            mdSeqChipsEl.appendChild(chip);
        }
    }
}

if (mdMoreBtn) {
    mdMoreBtn.addEventListener('click', () => {
        mdShowCount = mdShowCount === 10 ? 50 : 10;
        mdMoreBtn.textContent = mdShowCount === 10 ? 'More' : 'Less';
        updateMatchesDiffers();
    });
}

initOverUnder();

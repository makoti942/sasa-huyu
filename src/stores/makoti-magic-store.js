import { makeAutoObservable, runInAction } from 'mobx';
import { predictNextDigits } from '@/utils/differs-prediction-engine';
import { getAppId, getSocketURL } from '@/components/shared';
import { sendViaNewSystemWithPromise, onNewSystemMessage } from '@/auth/NewDerivAuth';

const ALL_SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];
const SYMBOL_LABELS = {
  R_10: 'Vol 10', R_25: 'Vol 25', R_50: 'Vol 50', R_75: 'Vol 75', R_100: 'Vol 100',
  '1HZ10V': 'Vol 10 (1s)', '1HZ25V': 'Vol 25 (1s)', '1HZ50V': 'Vol 50 (1s)',
  '1HZ75V': 'Vol 75 (1s)', '1HZ100V': 'Vol 100 (1s)',
};
const PIP_SIZES = {
  R_100: 2, R_75: 4, R_50: 4, R_25: 3, R_10: 3,
  '1HZ100V': 2, '1HZ75V': 2, '1HZ50V': 2, '1HZ25V': 2, '1HZ10V': 2,
};
const MAX_TICKS = 200;
const MIN_TICKS = 50;
const SCAN_INTERVAL = 400;
const ENTRY_COOLDOWN_MS = 1500;

const MIN_CONFIDENCE = 0.65;
const MIN_STRATEGY_AGREEMENT = 5;
const MIN_PATTERN_QUALITY = 0.60;
const MIN_DOMINANCE_GAP = 0.04;

class MakotiMagicStore {
  ws = null;
  connection_status = 'Offline';
  is_initialized = false;

  stake = '1';
  isRunning = false;

  symbolData = {};

  // One trade at a time
  isExecuting = false;
  activeContract = null;
  hasWon = false;
  lastTradeTime = 0;

  // Chase: re-fire same trade until win
  chaseSymbol = null;
  chaseDigit = null;
  chaseLossCount = 0;
  isChasing = false;

  previousPredictions = {};
  confirmedSignals = {};

  wins = 0;
  losses = 0;
  pnl = 0;
  tradeHistory = [];
  logs = [];
  maxLogs = 50;
  processedContracts = new Set();

  _pocUnsub = null;
  _chaseTimeout = null;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
    ALL_SYMBOLS.forEach(sym => {
      this.symbolData[sym] = { ticks: [], prices: [], prediction: null, confidence: 0, ready: false };
    });
  }

  // ── WebSocket ──────────────────────────────────────────────────────
  connectWebSocket = () => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.is_initialized) return;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }

    const server_url = getSocketURL();
    const app_id = getAppId();
    if (!server_url || !app_id) return;

    runInAction(() => { this.connection_status = 'Connecting...'; });

    this.ws = new WebSocket(`wss://${server_url}/websockets/v3?app_id=${app_id}`);

    this.ws.onopen = () => {
      runInAction(() => { this.connection_status = 'Live'; this.is_initialized = true; });
      this.subscribeAll();
    };

    this.ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.error) return;

        if (data.msg_type === 'history' && data.history?.prices) {
          const sym = data.echo_req?.ticks_history;
          if (!sym || !this.symbolData[sym]) return;
          const ps = PIP_SIZES[sym] || 2;
          const prices = data.history.prices.map(Number);
          const digits = prices.map(p => parseInt(Number(p).toFixed(ps).slice(-1), 10));
          runInAction(() => {
            const sd = this.symbolData[sym];
            sd.prices = prices.slice(-MAX_TICKS);
            sd.ticks = digits.slice(-MAX_TICKS);
            sd.ready = sd.ticks.length >= MIN_TICKS;
          });
        }

        if (data.msg_type === 'tick' && data.tick?.quote) {
          const sym = data.tick?.symbol;
          if (!sym || !this.symbolData[sym]) return;
          const ps = PIP_SIZES[sym] || 2;
          const price = Number(data.tick.quote);
          const digit = parseInt(Number(price).toFixed(ps).slice(-1), 10);
          runInAction(() => {
            const sd = this.symbolData[sym];
            sd.prices = [...sd.prices.slice(-MAX_TICKS + 1), price];
            sd.ticks = [...sd.ticks.slice(-MAX_TICKS + 1), digit];
            sd.ready = sd.ticks.length >= MIN_TICKS;
          });
        }
      } catch {}
    };

    this.ws.onclose = () => {
      runInAction(() => { this.connection_status = 'Offline'; this.is_initialized = false; });
      if (this.isRunning) setTimeout(() => this.connectWebSocket(), 3000);
    };

    this.ws.onerror = () => {
      runInAction(() => { this.connection_status = 'Error'; });
    };
  };

  subscribeAll = () => {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    ALL_SYMBOLS.forEach(sym => {
      this.ws.send(JSON.stringify({ ticks_history: sym, count: MAX_TICKS, end: 'latest', style: 'ticks', subscribe: 1 }));
    });
  };

  // ── Run / Stop ─────────────────────────────────────────────────────
  startRunning = () => {
    if (this.isRunning) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectWebSocket();
    }
    runInAction(() => {
      this.isRunning = true;
      this.hasWon = false;
      this.isExecuting = false;
      this.activeContract = null;
      this.isChasing = false;
      this.chaseSymbol = null;
      this.chaseDigit = null;
      this.chaseLossCount = 0;
      this.lastTradeTime = 0;
      this.previousPredictions = {};
      this.confirmedSignals = {};
      this.processedContracts = new Set();
    });
    this.addLog('🚀 Sniper scanner started — analyzing all volatilities for high-quality entry...', 'info');
    this.startPOCListener();
    this.scheduleScan();
  };

  stopRunning = () => {
    runInAction(() => {
      this.isRunning = false;
      this.isExecuting = false;
      this.isChasing = false;
    });
    if (this._chaseTimeout) { clearTimeout(this._chaseTimeout); this._chaseTimeout = null; }
    this.addLog('⏹ Scanner stopped', 'info');
    this.stopPOCListener();
  };

  scheduleScan = () => {
    if (!this.isRunning || this.hasWon || this.isExecuting || this.isChasing) return;
    setTimeout(() => this.runScan(), SCAN_INTERVAL);
  };

  // ── POC Listener ───────────────────────────────────────────────────
  startPOCListener = () => {
    this.stopPOCListener();
    this._pocUnsub = onNewSystemMessage((event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.msg_type !== 'proposal_open_contract') return;
        const c = data.proposal_open_contract;
        if (!c || !c.contract_id) return;

        if (c.is_sold) {
          // Skip if already processed this contract
          if (this.processedContracts.has(c.contract_id)) return;
          this.processedContracts.add(c.contract_id);

          const profit = Number(c.profit);
          const won = profit >= 0;
          runInAction(() => {
            this.pnl += profit;
            this.isExecuting = false;
            this.activeContract = null;

            if (won) {
              this.wins++;
              this.hasWon = true;
              this.isChasing = false;
              this.chaseSymbol = null;
              this.chaseDigit = null;
              this.chaseLossCount = 0;
              this.addLog(`✅ WON +$${profit.toFixed(2)} on ${SYMBOL_LABELS[c.underlying] || c.underlying} — D${c.barrier}`, 'win');
              this.addLog(`🎯 WINNER FOUND — stopping scanner`, 'win');
              this.isRunning = false;
            } else {
              this.losses++;
              this.lastTradeTime = Date.now();
              this.addLog(`❌ LOST -$${Math.abs(profit).toFixed(2)} on ${SYMBOL_LABELS[c.underlying] || c.underlying} — D${c.barrier}`, 'loss');

              // CHASE MODE: immediately re-fire same trade
              if (this.isRunning && this.chaseSymbol && this.chaseDigit !== null) {
                this.chaseLossCount++;
                this.addLog(`🔁 RE-FIRING ${SYMBOL_LABELS[this.chaseSymbol]} D${this.chaseDigit} — attempt #${this.chaseLossCount + 1}`, 'trade');
                // Fire immediately — no delay, no re-analyze
                setTimeout(() => this.fireChaseTrade(), 100);
              }
            }
            this.tradeHistory.push({
              symbol: c.underlying, profit, won,
              digit: c.barrier, timestamp: Date.now(),
            });
          });
        }
      } catch {}
    });
  };

  stopPOCListener = () => {
    if (this._pocUnsub) { this._pocUnsub(); this._pocUnsub = null; }
  };

  // ── Scan Loop — find first good signal ─────────────────────────────
  runScan = () => {
    if (!this.isRunning || this.hasWon || this.isExecuting || this.isChasing) return;

    const best = this.analyzeAllSymbols();
    if (best) {
      this.executeTrade(best);
      return;
    }

    this.scheduleScan();
  };

  // ── Fire Chase Trade — same symbol, same digit, no analysis ────────
  fireChaseTrade = async () => {
    if (!this.isRunning || this.hasWon || this.isExecuting) return;

    const sym = this.chaseSymbol;
    const digit = this.chaseDigit;
    if (!sym || digit === null) return;

    runInAction(() => { this.isExecuting = true; });

    const stakeAmount = parseFloat(this.stake) || 1;

    this.addLog(`🎯 CHASE #${this.chaseLossCount + 1} — ${SYMBOL_LABELS[sym]} D${digit} @ $${stakeAmount}`, 'trade');

    const params = {
      proposal: 1, amount: stakeAmount, basis: 'stake', currency: 'USD',
      symbol: sym, contract_type: 'DIGITMATCH',
      duration: 1, duration_unit: 't',
      barrier: String(digit),
    };

    try {
      const proposalRes = await sendViaNewSystemWithPromise(params);
      if (!proposalRes?.proposal) {
        this.addLog(`⚠️ No proposal for ${SYMBOL_LABELS[sym]}`, 'info');
        runInAction(() => { this.isExecuting = false; });
        if (this.isRunning && !this.hasWon) setTimeout(() => this.fireChaseTrade(), 300);
        return;
      }

      const buyParams = {
        buy: 1, price: stakeAmount, parameters: {
          amount: stakeAmount, basis: 'stake', currency: 'USD',
          symbol: sym, contract_type: 'DIGITMATCH',
          duration: 1, duration_unit: 't',
          barrier: String(digit),
        },
      };

      const buyRes = await sendViaNewSystemWithPromise(buyParams);
      const contractId = buyRes?.buy?.contract_id ?? buyRes?.contract_id;

      if (contractId) {
        runInAction(() => {
          this.activeContract = { id: contractId, symbol: sym, digit, stake: stakeAmount, confidence: 0 };
        });
        this.addLog(`📡 Contract ${contractId} — D${digit} on ${SYMBOL_LABELS[sym]} @ $${stakeAmount}`, 'trade');
      } else {
        this.addLog(`⚠️ Buy ok but no contract_id`, 'info');
        runInAction(() => { this.isExecuting = false; });
        if (this.isRunning && !this.hasWon) setTimeout(() => this.fireChaseTrade(), 300);
      }
    } catch (err) {
      this.addLog(`⚠️ Trade error: ${err.message || err}`, 'info');
      runInAction(() => { this.isExecuting = false; });
      if (this.isRunning && !this.hasWon) setTimeout(() => this.fireChaseTrade(), 300);
    }
  };

  // ── Execute First Trade — sets up chase mode ───────────────────────
  executeTrade = async (signal) => {
    if (!this.isRunning || this.hasWon || this.isExecuting) return;

    runInAction(() => { this.isExecuting = true; });

    const { symbol, digit, confidence, strategyAgreement, patternQuality } = signal;
    const stakeAmount = parseFloat(this.stake) || 1;

    // Set chase mode — this will be used for all subsequent re-fires
    runInAction(() => {
      this.chaseSymbol = symbol;
      this.chaseDigit = digit;
      this.chaseLossCount = 0;
      this.isChasing = true;
    });

    this.addLog(`🎯 SNIPER ENTRY [${(confidence * 100).toFixed(0)}%] ${SYMBOL_LABELS[symbol]} — D${digit} | Agreement: ${strategyAgreement} | Quality: ${(patternQuality * 100).toFixed(0)}%`, 'trade');

    const params = {
      proposal: 1, amount: stakeAmount, basis: 'stake', currency: 'USD',
      symbol, contract_type: 'DIGITMATCH',
      duration: 1, duration_unit: 't',
      barrier: String(digit),
    };

    try {
      const proposalRes = await sendViaNewSystemWithPromise(params);
      if (!proposalRes?.proposal) {
        this.addLog(`⚠️ No proposal for ${SYMBOL_LABELS[symbol]}`, 'info');
        runInAction(() => { this.isExecuting = false; this.isChasing = false; });
        if (this.isRunning && !this.hasWon) this.scheduleScan();
        return;
      }

      const buyParams = {
        buy: 1, price: stakeAmount, parameters: {
          amount: stakeAmount, basis: 'stake', currency: 'USD',
          symbol, contract_type: 'DIGITMATCH',
          duration: 1, duration_unit: 't',
          barrier: String(digit),
        },
      };

      const buyRes = await sendViaNewSystemWithPromise(buyParams);
      const contractId = buyRes?.buy?.contract_id ?? buyRes?.contract_id;

      if (contractId) {
        runInAction(() => {
          this.activeContract = { id: contractId, symbol, digit, stake: stakeAmount, confidence };
        });
        this.addLog(`📡 Contract ${contractId} — D${digit} on ${SYMBOL_LABELS[symbol]} @ $${stakeAmount}`, 'trade');
      } else {
        this.addLog(`⚠️ Buy ok but no contract_id`, 'info');
        runInAction(() => { this.isExecuting = false; this.isChasing = false; });
        if (this.isRunning && !this.hasWon) this.scheduleScan();
      }
    } catch (err) {
      this.addLog(`⚠️ Trade error: ${err.message || err}`, 'info');
      runInAction(() => { this.isExecuting = false; this.isChasing = false; });
      if (this.isRunning && !this.hasWon) this.scheduleScan();
    }
  };

  // ── Analysis ───────────────────────────────────────────────────────
  analyzeAllSymbols = () => {
    let best = null;

    ALL_SYMBOLS.forEach(sym => {
      const sd = this.symbolData[sym];
      if (!sd || !sd.ready || sd.ticks.length < MIN_TICKS) return;

      const result = predictNextDigits(sd.ticks);
      const top = result.rankedDigits[0];
      if (!top) return;

      const confidence = result.overallConfidence;
      const predictedDigit = top.digit;
      const dominance = result.rankedDigits[0].score - result.rankedDigits[1].score;

      const multiTF = this.multiTimeframeCheck(sd.ticks, predictedDigit);
      const strategyAgreement = this.countEngineAgreement(result, predictedDigit);
      const patternQuality = this.assessPatternQuality(sd.ticks, predictedDigit);

      const now = Date.now();
      const prev = this.previousPredictions[sym];
      if (prev && prev.digit === predictedDigit) {
        this.confirmedSignals[sym] = (this.confirmedSignals[sym] || 0) + 1;
      } else {
        this.confirmedSignals[sym] = 1;
      }
      this.previousPredictions[sym] = { digit: predictedDigit, confidence, timestamp: now };

      runInAction(() => {
        sd.prediction = {
          digit: predictedDigit, confidence, summary: result.summary,
          strategyAgreement, patternQuality, multiTF,
          confirmed: this.confirmedSignals[sym] || 0,
        };
        sd.confidence = confidence;
      });

      if (!this.validateEntry(sym, predictedDigit, confidence, strategyAgreement, patternQuality, dominance, multiTF)) return;

      const score = confidence * patternQuality * (1 + strategyAgreement * 0.08) * (1 + multiTF * 0.1) * (1 + dominance * 5);
      if (!best || score > best.score) {
        best = {
          symbol: sym, digit: predictedDigit, confidence,
          score, strategyAgreement, patternQuality, dominance, multiTF,
          summary: result.summary,
        };
      }
    });

    return best;
  };

  validateEntry = (sym, digit, confidence, strategyAgreement, patternQuality, dominance, multiTF) => {
    const now = Date.now();
    if (confidence < MIN_CONFIDENCE) return false;
    if (strategyAgreement < MIN_STRATEGY_AGREEMENT) return false;
    if (patternQuality < MIN_PATTERN_QUALITY) return false;
    if (dominance < MIN_DOMINANCE_GAP) return false;
    if (multiTF < 2) return false;

    const prev = this.previousPredictions[sym];
    if (!prev || prev.digit !== digit) return false;
    if ((now - prev.timestamp) > 5000) return false;
    if ((this.confirmedSignals[sym] || 0) < 2) return false;
    if (now - this.lastTradeTime < ENTRY_COOLDOWN_MS) return false;

    const sd = this.symbolData[sym];
    if (sd && sd.ticks.length > 0) {
      const lastIdx = sd.ticks.lastIndexOf(digit);
      const ticksSince = sd.ticks.length - 1 - lastIdx;
      if (ticksSince < 3) return false;
    }
    if (sd && sd.ticks.length >= 5) {
      const last5Count = sd.ticks.slice(-5).filter(d => d === digit).length;
      if (last5Count >= 3) return false;
    }

    return true;
  };

  multiTimeframeCheck = (ticks, targetDigit) => {
    const windows = [10, 20, 50, 100];
    let agreeCount = 0;
    for (const w of windows) {
      const slice = ticks.slice(-w);
      if (slice.length < 5) continue;
      const freq = Array(10).fill(0);
      slice.forEach(d => { if (d >= 0 && d <= 9) freq[d]++; });
      const maxFreq = Math.max(...freq);
      const dominant = freq.indexOf(maxFreq);
      const total = freq.reduce((a, b) => a + b, 0);
      const pct = maxFreq / total;
      if (dominant === targetDigit && pct > 0.12) agreeCount++;
    }
    return agreeCount;
  };

  countEngineAgreement = (result, targetDigit) => {
    const topDigits = result.rankedDigits.slice(0, 5).map(r => r.digit);
    let agreement = 0;
    if (topDigits.includes(targetDigit)) agreement++;
    if (result.rankedDigits[0].digit === targetDigit) {
      agreement++;
      if (result.rankedDigits[0].score - result.rankedDigits[1].score > 0.02) agreement++;
      if (result.rankedDigits[0].score - result.rankedDigits[1].score > 0.05) agreement++;
    }
    const top4Matches = topDigits.slice(0, 4).filter(d => d === targetDigit).length;
    if (top4Matches >= 2) agreement++;
    if (top4Matches >= 3) agreement++;
    if (result.overallConfidence > 0.6) agreement++;
    if (result.overallConfidence > 0.75) agreement++;
    return agreement;
  };

  assessPatternQuality = (ticks, predictedDigit) => {
    if (ticks.length < 20) return 0.5;
    let quality = 0.5;
    const last10 = ticks.slice(-10);
    const last20 = ticks.slice(-20);
    const last10Count = last10.filter(d => d === predictedDigit).length;
    if (last10Count >= 3) quality += 0.12;
    else if (last10Count >= 2) quality += 0.06;
    const last5 = ticks.slice(-5);
    const last5Count = last5.filter(d => d === predictedDigit).length;
    if (last5Count === 0) quality += 0.15;
    else if (last5Count === 1) quality += 0.05;
    else if (last5Count >= 3) quality -= 0.2;
    const freq20 = Array(10).fill(0);
    last20.forEach(d => freq20[d]++);
    const expected20 = last20.length / 10;
    if (freq20[predictedDigit] >= expected20 * 1.2) quality += 0.1;
    let alternations = 0;
    for (let i = 1; i < Math.min(20, ticks.length); i++) {
      if (ticks[ticks.length - i] !== ticks[ticks.length - i - 1]) alternations++;
    }
    const altRate = alternations / Math.min(19, ticks.length - 1);
    if (altRate > 0.65) quality += 0.08;
    const lastIdx = ticks.lastIndexOf(predictedDigit);
    const gap = ticks.length - 1 - lastIdx;
    const avgGap = ticks.length / (ticks.filter(d => d === predictedDigit).length || 1);
    if (gap >= avgGap * 0.8 && gap <= avgGap * 1.5) quality += 0.1;
    else if (gap < avgGap * 0.3) quality -= 0.1;
    return Math.max(0.1, Math.min(1, quality));
  };

  setStake = (val) => { this.stake = val; };

  addLog = (text, type = 'info') => {
    runInAction(() => {
      this.logs = [{ text, type, time: Date.now() }, ...this.logs].slice(0, this.maxLogs);
    });
  };

  dispose = () => {
    this.isRunning = false;
    this.isExecuting = false;
    this.isChasing = false;
    this.processedContracts = new Set();
    if (this._chaseTimeout) { clearTimeout(this._chaseTimeout); this._chaseTimeout = null; }
    this.stopPOCListener();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  };
}

export default new MakotiMagicStore();

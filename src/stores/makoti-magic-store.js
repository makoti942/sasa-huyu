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
const MIN_CONFIDENCE = 0.40;
const MIN_TICKS = 50;
const SCAN_INTERVAL = 500;
const ENTRY_COOLDOWN_MS = 2000;
const MIN_STRATEGY_AGREEMENT = 3;

class MakotiMagicStore {
  // Connection
  ws = null;
  connection_status = 'Offline';
  is_initialized = false;

  // Config
  stake = '1';
  isRunning = false;

  // Per-symbol data
  symbolData = {};

  // Analysis
  bestSignal = null;
  scanAttempts = 0;

  // Trade state
  activeContract = null;
  hasWon = false;
  lastTradeTime = 0;
  previousPredictions = {}; // symbol -> { digit, confidence, timestamp }
  confirmedSignals = {};    // symbol -> confirmation count

  // Stats
  wins = 0;
  losses = 0;
  pnl = 0;
  tradeHistory = [];

  // Logs
  logs = [];
  maxLogs = 50;

  // Unsubscribers
  _pocUnsub = null;

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
        if (data.subscription?.id) {}

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
            sd.ready = sd.ticks.length >= 30;
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
            sd.ready = sd.ticks.length >= 30;
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
      this.activeContract = null;
      this.bestSignal = null;
      this.scanAttempts = 0;
      this.lastTradeTime = 0;
      this.previousPredictions = {};
      this.confirmedSignals = {};
    });
    this.addLog('🚀 Sniper scanner started — analyzing all volatilities for perfect entry...', 'info');
    this.startPOCListener();
    this.runScanLoop();
  };

  stopRunning = () => {
    runInAction(() => { this.isRunning = false; });
    this.addLog('⏹ Scanner stopped', 'info');
    this.stopPOCListener();
  };

  // ── POC Listener (contract results) ────────────────────────────────
  startPOCListener = () => {
    this.stopPOCListener();
    this._pocUnsub = onNewSystemMessage((event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.msg_type !== 'proposal_open_contract') return;
        const c = data.proposal_open_contract;
        if (!c || !c.contract_id) return;

        if (c.is_sold) {
          const profit = Number(c.profit);
          const won = profit >= 0;
          runInAction(() => {
            this.pnl += profit;
            if (won) {
              this.wins++;
              this.hasWon = true;
              this.addLog(`✅ WON +$${profit.toFixed(2)} on ${SYMBOL_LABELS[c.underlying] || c.underlying}`, 'win');
              this.addLog(`🎯 WINNER FOUND — stopping scanner`, 'win');
              this.isRunning = false;
            } else {
              this.losses++;
              this.addLog(`❌ LOST -$${Math.abs(profit).toFixed(2)} on ${SYMBOL_LABELS[c.underlying] || c.underlying}`, 'loss');
              this.activeContract = null;
              this.lastTradeTime = Date.now();
              this.scanAttempts = 0;
            }
            this.tradeHistory.push({
              symbol: c.underlying, profit, won,
              digit: c.barrier, timestamp: Date.now(),
            });
          });
          if (!won && this.isRunning) {
            setTimeout(() => this.runScanLoop(), 500);
          }
        }
      } catch {}
    });
  };

  stopPOCListener = () => {
    if (this._pocUnsub) { this._pocUnsub(); this._pocUnsub = null; }
  };

  // ── Scan Loop ──────────────────────────────────────────────────────
  runScanLoop = () => {
    if (!this.isRunning || this.hasWon || this.activeContract) return;

    this.scanAttempts++;
    this.analyzeAllSymbols();

    if (this.bestSignal) {
      this.executeTrade(this.bestSignal);
      return;
    }

    if (this.isRunning && !this.hasWon) {
      setTimeout(() => this.runScanLoop(), SCAN_INTERVAL);
    }
  };

  // ── Sniper Entry Validation ────────────────────────────────────────
  validateSniperEntry = (sym, digit, confidence, strategyAgreement) => {
    // 1. Must have enough ticks
    const sd = this.symbolData[sym];
    if (!sd || sd.ticks.length < MIN_TICKS) return false;

    // 2. Confidence must be above 40%
    if (confidence < MIN_CONFIDENCE) return false;

    // 3. Must have enough strategies agreeing on the same digit
    if (strategyAgreement < MIN_STRATEGY_AGREEMENT) return false;

    // 4. Cooldown — don't trade too fast
    const now = Date.now();
    if (now - this.lastTradeTime < ENTRY_COOLDOWN_MS) return false;

    // 5. Stability check — same digit must have been predicted in previous scan too
    const prev = this.previousPredictions[sym];
    if (prev && prev.digit === digit && (now - prev.timestamp) < 3000) {
      // Same digit predicted twice in 3 seconds — stable signal
      return true;
    }

    // 6. For first-time signals, require extra high confidence
    if (!prev || prev.digit !== digit) {
      return confidence >= 0.42 && strategyAgreement >= 4;
    }

    return false;
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

      // Count how many strategies agree on the top digit
      const strategyAgreement = this.countStrategyAgreement(sd.ticks, predictedDigit);

      // Store previous prediction for stability check
      const now = Date.now();
      const prev = this.previousPredictions[sym];
      if (prev && prev.digit === predictedDigit) {
        // Same digit — increment confirmation count
        this.confirmedSignals[sym] = (this.confirmedSignals[sym] || 0) + 1;
      } else {
        this.confirmedSignals[sym] = 1;
      }
      this.previousPredictions[sym] = { digit: predictedDigit, confidence, timestamp: now };

      // Pattern quality score
      const patternQuality = this.assessPatternQuality(sd.ticks, predictedDigit);

      runInAction(() => {
        sd.prediction = {
          digit: predictedDigit, confidence, summary: result.summary,
          strategyAgreement, patternQuality,
          confirmed: this.confirmedSignals[sym] || 0,
        };
        sd.confidence = confidence;
      });

      // Validate as sniper entry
      const isValid = this.validateSniperEntry(sym, predictedDigit, confidence, strategyAgreement);

      if (isValid) {
        // Score = confidence * patternQuality * agreement bonus
        const score = confidence * patternQuality * (1 + strategyAgreement * 0.1);
        if (!best || score > best.score) {
          best = {
            symbol: sym, digit: predictedDigit, confidence,
            score, strategyAgreement, patternQuality,
            summary: result.summary,
          };
        }
      }
    });

    runInAction(() => { this.bestSignal = best; });
  };

  // Count how many strategies predict the same top digit
  countStrategyAgreement = (ticks, targetDigit) => {
    if (ticks.length < 10) return 0;
    let agreement = 0;
    const windows = [5, 10, 20, 30, 50];

    for (const w of windows) {
      const slice = ticks.slice(-w);
      if (slice.length < 5) continue;
      const freq = Array(10).fill(0);
      slice.forEach(d => { if (d >= 0 && d <= 9) freq[d]++; });
      const total = freq.reduce((a, b) => a + b, 0) || 1;
      const maxFreq = Math.max(...freq);
      const dominantDigit = freq.indexOf(maxFreq);
      if (dominantDigit === targetDigit && (maxFreq / total) > 0.12) {
        agreement++;
      }
    }

    // Check recent 3-tick and 5-tick patterns
    const last3 = ticks.slice(-3);
    const last5 = ticks.slice(-5);
    if (last3.length >= 3) {
      const freq3 = Array(10).fill(0);
      last3.forEach(d => freq3[d]++);
      if (freq3[targetDigit] >= 2) agreement++;
    }
    if (last5.length >= 5) {
      const freq5 = Array(10).fill(0);
      last5.forEach(d => freq5[d]++);
      if (freq5[targetDigit] >= 2) agreement++;
    }

    return agreement;
  };

  // Assess pattern quality (0 to 1)
  assessPatternQuality = (ticks, predictedDigit) => {
    if (ticks.length < 20) return 0.5;
    let quality = 0.5;

    // 1. Check if predicted digit has strong recent momentum
    const last10 = ticks.slice(-10);
    const last10Count = last10.filter(d => d === predictedDigit).length;
    if (last10Count >= 3) quality += 0.15;
    else if (last10Count >= 2) quality += 0.08;

    // 2. Check if digit is NOT exhausted (appeared too much recently = less likely)
    const last5 = ticks.slice(-5);
    const last5Count = last5.filter(d => d === predictedDigit).length;
    if (last5Count >= 3) quality -= 0.2; // Over-appeared, less likely
    if (last5Count === 0) quality += 0.1; // Absent recently, more likely to appear

    // 3. Check for alternating pattern strength
    let alternations = 0;
    for (let i = 1; i < Math.min(20, ticks.length); i++) {
      if (ticks[ticks.length - i] !== ticks[ticks.length - i - 1]) alternations++;
    }
    const altRate = alternations / Math.min(19, ticks.length - 1);
    if (altRate > 0.6) quality += 0.1; // Good alternation = more predictable

    // 4. Check if digit frequency is above average in recent window
    const recent50 = ticks.slice(-50);
    const freq50 = Array(10).fill(0);
    recent50.forEach(d => freq50[d]++);
    const avg50 = recent50.length / 10;
    if (freq50[predictedDigit] > avg50 * 1.2) quality += 0.1;

    return Math.max(0.1, Math.min(1, quality));
  };

  // ── Execute Trade ──────────────────────────────────────────────────
  executeTrade = async (signal) => {
    if (!this.isRunning || this.hasWon || this.activeContract) return;

    const { symbol, digit, confidence, strategyAgreement, patternQuality } = signal;
    const stakeAmount = parseFloat(this.stake) || 1;

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
        if (this.isRunning && !this.hasWon) setTimeout(() => this.runScanLoop(), SCAN_INTERVAL);
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
        this.addLog(`📡 Contract ${contractId} opened — D${digit} on ${SYMBOL_LABELS[symbol]} @ $${stakeAmount}`, 'trade');
      } else {
        this.addLog(`⚠️ Buy ok but no contract_id`, 'info');
        if (this.isRunning && !this.hasWon) setTimeout(() => this.runScanLoop(), SCAN_INTERVAL);
      }
    } catch (err) {
      this.addLog(`⚠️ Trade error: ${err.message || err}`, 'info');
      if (this.isRunning && !this.hasWon) setTimeout(() => this.runScanLoop(), SCAN_INTERVAL);
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────
  setStake = (val) => { this.stake = val; };

  addLog = (text, type = 'info') => {
    runInAction(() => {
      this.logs = [{ text, type, time: Date.now() }, ...this.logs].slice(0, this.maxLogs);
    });
  };

  dispose = () => {
    this.isRunning = false;
    this.stopPOCListener();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  };
}

export default new MakotiMagicStore();

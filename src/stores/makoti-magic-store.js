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

// Realistic thresholds (engine confidence is 0.10 base, max 0.25)
const NORMAL_MODE_CONFIDENCE = 0.14;
const NORMAL_MODE_DOMINANCE = 0.03;
const NORMAL_MODE_MULTI_TF = 2;
const SCAN_INTERVAL = 400;
const ENTRY_COOLDOWN_MS = 1500;

class MakotiMagicStore {
  ws = null;
  connection_status = 'Offline';
  is_initialized = false;

  stake = '1';
  isRunning = false;
  tradeEveryTick = false;

  symbolData = {};

  // Trade enforcement
  isExecuting = false;
  activeContract = null;
  hasWon = false;
  lastTradeTime = 0;

  // Chase mode
  chaseSymbol = null;
  chaseDigit = null;
  chaseLossCount = 0;
  isChasing = false;

  // Prediction tracking
  bestPrediction = null; // { symbol, digit, confidence } for every-tick mode
  scanAttempts = 0;

  // Stats
  wins = 0;
  losses = 0;
  pnl = 0;
  tradeHistory = [];
  logs = [];
  maxLogs = 50;
  processedContracts = new Set();

  _pocUnsub = null;
  _scanTimeout = null;

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

          // In every-tick mode, fire on every tick immediately — no blocking
          if (this.isRunning && this.tradeEveryTick && !this.hasWon) {
            this.handleTickForEveryTickMode(sym);
          }
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

  // ── Every-Tick Mode: fire immediately on each incoming tick ─────────
  handleTickForEveryTickMode = (sym) => {
    if (!this.isRunning || this.hasWon) return;

    // If chasing, only process the chase symbol
    if (this.isChasing && this.chaseSymbol && sym !== this.chaseSymbol) return;

    const sd = this.symbolData[sym];
    if (!sd || !sd.ready || sd.ticks.length < MIN_TICKS) return;

    // If chasing, fire chase digit directly — no analysis needed
    if (this.isChasing && this.chaseSymbol === sym && this.chaseDigit !== null) {
      this.bestPrediction = { symbol: sym, digit: this.chaseDigit, confidence: 0.12 };
      this.fireEveryTickTrade(sym, this.chaseDigit);
      return;
    }

    // Analyze and pick best digit
    const result = predictNextDigits(sd.ticks);
    const top = result.rankedDigits[0];
    if (!top) return;

    const predictedDigit = top.digit;

    runInAction(() => {
      sd.prediction = {
        digit: predictedDigit, confidence: result.overallConfidence,
        summary: result.summary, strategyAgreement: 0, patternQuality: 0, multiTF: 0, confirmed: 0,
      };
      sd.confidence = result.overallConfidence;
      this.bestPrediction = { symbol: sym, digit: predictedDigit, confidence: result.overallConfidence };
    });

    // First tick: set chase mode
    if (!this.isChasing) {
      runInAction(() => {
        this.chaseSymbol = sym;
        this.chaseDigit = predictedDigit;
        this.chaseLossCount = 0;
        this.isChasing = true;
      });
    }

    this.fireEveryTickTrade(sym, predictedDigit);
  };

  // Fire on every tick — no waiting, no blocking
  fireEveryTickTrade = async (sym, digit) => {
    if (!this.isRunning || this.hasWon) return;

    const stakeAmount = parseFloat(this.stake) || 1;

    const params = {
      proposal: 1, amount: stakeAmount, basis: 'stake', currency: 'USD',
      symbol: sym, contract_type: 'DIGITMATCH',
      duration: 1, duration_unit: 't',
      barrier: String(digit),
    };

    try {
      const proposalRes = await sendViaNewSystemWithPromise(params);
      if (!proposalRes?.proposal) return;

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
      }
    } catch (err) {}
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
      this.scanAttempts = 0;
      this.bestPrediction = null;
      this.processedContracts = new Set();
    });
    if (this.tradeEveryTick) {
      this.addLog('⚡ TRADE ON EVERY TICK mode — firing on every tick until win', 'info');
    } else {
      this.addLog('🔍 Scanning for high-quality entries...', 'info');
    }
    this.startPOCListener();
    if (!this.tradeEveryTick) this.scheduleScan();
  };

  stopRunning = () => {
    runInAction(() => {
      this.isRunning = false;
      this.isExecuting = false;
      this.isChasing = false;
    });
    if (this._scanTimeout) { clearTimeout(this._scanTimeout); this._scanTimeout = null; }
    this.addLog('⏹ Stopped', 'info');
    this.stopPOCListener();
  };

  scheduleScan = () => {
    if (!this.isRunning || this.hasWon || this.isExecuting || this.isChasing || this.tradeEveryTick) return;
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
          if (this.processedContracts.has(c.contract_id)) return;
          this.processedContracts.add(c.contract_id);

          const profit = Number(c.profit);
          const won = profit >= 0;
          runInAction(() => {
            this.pnl += profit;
            this.isExecuting = false;

            if (c.contract_id === this.activeContract?.id) {
              this.activeContract = null;
            }

            if (won) {
              this.wins++;
              this.hasWon = true;
              this.isChasing = false;
              this.chaseSymbol = null;
              this.chaseDigit = null;
              this.chaseLossCount = 0;
              this.addLog(`✅ WON +$${profit.toFixed(2)} on ${SYMBOL_LABELS[c.underlying] || c.underlying} — D${c.barrier}`, 'win');
              this.addLog(`🎯 WINNER FOUND — stopping`, 'win');
              this.isRunning = false;
            } else {
              this.losses++;
              this.lastTradeTime = Date.now();
              this.addLog(`❌ LOST -$${Math.abs(profit).toFixed(2)} on ${SYMBOL_LABELS[c.underlying] || c.underlying} — D${c.barrier}`, 'loss');

              // In every-tick mode: just continue (next tick will fire again)
              // In normal mode: continue scan loop to find next signal
              if (this.tradeEveryTick) {
                this.chaseLossCount++;
              }
            }
            this.tradeHistory.push({
              symbol: c.underlying, profit, won,
              digit: c.barrier, timestamp: Date.now(),
            });
          });
          if (!won && this.isRunning && !this.tradeEveryTick) {
            this.scheduleScan();
          }
        }
      } catch {}
    });
  };

  stopPOCListener = () => {
    if (this._pocUnsub) { this._pocUnsub(); this._pocUnsub = null; }
  };

  // ── Normal Mode: Scan Loop ────────────────────────────────────────
  runScan = () => {
    if (!this.isRunning || this.hasWon || this.isExecuting || this.tradeEveryTick) return;

    this.scanAttempts++;
    const best = this.analyzeAllSymbols();
    if (best) {
      this.executeNormalTrade(best);
      return;
    }
    this.scheduleScan();
  };

  // ── Normal Mode: Analysis ──────────────────────────────────────────
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
      const dominance = top.score - result.rankedDigits[1].score;

      if (confidence < NORMAL_MODE_CONFIDENCE) return;
      if (dominance < NORMAL_MODE_DOMINANCE) return;

      const multiTF = this.multiTimeframeCheck(sd.ticks, predictedDigit);
      if (multiTF < NORMAL_MODE_MULTI_TF) return;

      // Check digit hasn't appeared too recently
      const lastIdx = sd.ticks.lastIndexOf(predictedDigit);
      const ticksSince = sd.ticks.length - 1 - lastIdx;
      if (ticksSince < 3) return;

      // Check digit not over-appeared in last 5
      const last5Count = sd.ticks.slice(-5).filter(d => d === predictedDigit).length;
      if (last5Count >= 3) return;

      // Cooldown
      if (Date.now() - this.lastTradeTime < ENTRY_COOLDOWN_MS) return;

      const score = confidence * (1 + dominance * 10) * (1 + multiTF * 0.1);
      if (!best || score > best.score) {
        best = {
          symbol: sym, digit: predictedDigit, confidence,
          score, dominance, multiTF, summary: result.summary,
        };
      }
    });

    return best;
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
      if (dominant === targetDigit && (maxFreq / total) > 0.12) agreeCount++;
    }
    return agreeCount;
  };

  // ── Normal Mode: Execute Trade ─────────────────────────────────────
  executeNormalTrade = async (signal) => {
    if (!this.isRunning || this.hasWon || this.isExecuting) return;

    runInAction(() => { this.isExecuting = true; });

    const { symbol, digit, confidence } = signal;
    const stakeAmount = parseFloat(this.stake) || 1;

    runInAction(() => {
      this.chaseSymbol = symbol;
      this.chaseDigit = digit;
      this.chaseLossCount = 0;
      this.isChasing = true;
    });

    this.addLog(`🎯 ENTRY ${(confidence * 100).toFixed(0)}% ${SYMBOL_LABELS[symbol]} — D${digit}`, 'trade');

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

  // ── Helpers ────────────────────────────────────────────────────────
  setStake = (val) => { this.stake = val; };
  setTradeEveryTick = (val) => { this.tradeEveryTick = val; };

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
    if (this._scanTimeout) { clearTimeout(this._scanTimeout); this._scanTimeout = null; }
    this.stopPOCListener();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  };
}

export default new MakotiMagicStore();

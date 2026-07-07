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
const MIN_CONFIDENCE = 0.38;
const SCAN_INTERVAL = 600;

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
    });
    this.addLog('🚀 Scanner started — analyzing all volatilities...', 'info');
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

  // ── Analysis ───────────────────────────────────────────────────────
  analyzeAllSymbols = () => {
    let best = null;

    ALL_SYMBOLS.forEach(sym => {
      const sd = this.symbolData[sym];
      if (!sd || !sd.ready || sd.ticks.length < 30) return;

      const result = predictNextDigits(sd.ticks);
      const top = result.rankedDigits[0];
      if (!top) return;

      const confidence = result.overallConfidence;
      const predictedDigit = top.digit;

      runInAction(() => {
        sd.prediction = { digit: predictedDigit, confidence, summary: result.summary };
        sd.confidence = confidence;
      });

      if (confidence >= MIN_CONFIDENCE) {
        if (!best || confidence > best.confidence) {
          best = { symbol: sym, digit: predictedDigit, confidence, summary: result.summary };
        }
      }
    });

    runInAction(() => { this.bestSignal = best; });
  };

  // ── Execute Trade ──────────────────────────────────────────────────
  executeTrade = async (signal) => {
    if (!this.isRunning || this.hasWon || this.activeContract) return;

    const { symbol, digit, confidence } = signal;
    const stakeAmount = parseFloat(this.stake) || 1;

    this.addLog(`🎯 [${(confidence * 100).toFixed(0)}%] Entry found: ${SYMBOL_LABELS[symbol]} — predicting D${digit}`, 'trade');

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

export interface PredictionResult {
    top4Digits: number[];
    rankedDigits: Array<{ digit: number; score: number }>;
    overallConfidence: number;
    summary: string;
    predictedDigit: number | null;
}

interface StrategyResult {
    scores: number[];
    confidence: number;
    name: string;
    tier: 1 | 2 | 3;
}

const TIER_WEIGHT: Record<1 | 2 | 3, number> = { 1: 5.0, 2: 2.5, 3: 1.0 };

function normaliseScores(scores: number[]): number[] {
    const total = scores.reduce((a, b) => a + b, 0);
    if (total === 0) return Array(10).fill(0.1);
    return scores.map(s => s / total);
}

function getRecentFrequency(history: number[], window: number): number[] {
    const recent = history.slice(-window);
    const counts = Array(10).fill(0);
    recent.forEach(d => { if (d >= 0 && d <= 9) counts[d]++; });
    return counts;
}

// ── 1. Deep N-Gram with multiple contexts ─────────────────────────────────────
function nGramStrategy(history: number[], n: number): StrategyResult {
    const name = `nGram-${n}`;
    const scores = Array(10).fill(0) as number[];
    if (history.length < n + 1) return { scores: normaliseScores(scores), confidence: 0, name, tier: 1 };

    const table = new Map<string, number[]>();
    for (let i = 0; i <= history.length - n - 1; i++) {
        const key = history.slice(i, i + n).join(',');
        if (!table.has(key)) table.set(key, Array(10).fill(0));
        table.get(key)![history[i + n]]++;
    }
    const key = history.slice(-n).join(',');
    const counts = table.get(key);
    if (!counts) return { scores: normaliseScores(scores), confidence: 0, name, tier: 1 };

    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) return { scores: normaliseScores(scores), confidence: 0, name, tier: 1 };

    counts.forEach((c, i) => { scores[i] = c / total; });
    return { scores, confidence: Math.max(...scores), name, tier: 1 };
}

// ── 2. Advanced Markov Chain with multiple lookbacks ───────────────────────
function markovChainStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    if (history.length < 3) return { scores: normaliseScores(scores), confidence: 0, name: 'markov', tier: 1 };

    const weights: number[] = [];
    const results: number[][] = [];

    for (let lookback = 1; lookback <= 3; lookback++) {
        const matrix: number[][] = Array.from({ length: 10 }, () => Array(10).fill(0));
        for (let i = lookback; i < history.length; i++) {
            const from = history[i - lookback], to = history[i];
            if (from >= 0 && from <= 9 && to >= 0 && to <= 9) matrix[from][to]++;
        }
        const last = history[history.length - lookback];
        if (last < 0 || last > 9) continue;
        const row = matrix[last];
        const total = row.reduce((a, b) => a + b, 0);
        if (total > 0) {
            weights.push(4 - lookback);
            results.push(row.map(c => c / total));
        }
    }

    if (results.length === 0) return { scores: normaliseScores(scores), confidence: 0, name: 'markov', tier: 1 };

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    results.forEach((probs, idx) => {
        probs.forEach((p, d) => { scores[d] += p * (weights[idx] / totalWeight); });
    });

    return { scores: normaliseScores(scores), confidence: Math.max(...scores), name: 'markov', tier: 1 };
}

// ── 3. Multi-Scale Cyclical Pattern Detection ─────────────────────────────
function cyclicalPatternStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    const minLen = 8;
    if (history.length < minLen) return { scores: normaliseScores(scores), confidence: 0, name: 'cyclical', tier: 2 };

    let bestCycleLen = 0, bestScore = 0;

    for (let cycleLen = 2; cycleLen <= 10; cycleLen++) {
        if (history.length < cycleLen * 2) continue;
        let matches = 0;
        const checks = Math.min(history.length - cycleLen, cycleLen * 4);
        for (let i = 0; i < checks; i++) {
            if (history[history.length - 1 - i] === history[history.length - 1 - i - cycleLen]) matches++;
        }
        const score = matches / checks;
        if (score > bestScore) { bestScore = score; bestCycleLen = cycleLen; }
    }

    if (bestScore > 0.55 && bestCycleLen > 0) {
        const predictedIdx = history.length % bestCycleLen;
        const window = history.slice(-bestCycleLen * 5);
        const cycleVotes = Array(10).fill(0) as number[];
        for (let j = predictedIdx; j < window.length; j += bestCycleLen) {
            const d = window[j];
            if (d >= 0 && d <= 9) cycleVotes[d]++;
        }
        const total = cycleVotes.reduce((a, b) => a + b, 0);
        if (total > 0) cycleVotes.forEach((c, i) => { scores[i] = (c / total) * bestScore; });
    }

    return { scores: normaliseScores(scores), confidence: bestScore, name: 'cyclical', tier: 2 };
}

// ── 4. Deep KNN with multiple windows ──────────────────────────────────────
function knnPatternStrategy(history: number[], k = 7, winLen = 3): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    if (history.length < winLen + 1) return { scores: normaliseScores(scores), confidence: 0, name: 'knn', tier: 1 };

    const current = history.slice(-winLen);
    const candidates: Array<{ dist: number; next: number }> = [];

    for (let i = 0; i <= history.length - winLen - 1; i++) {
        let dist = 0;
        for (let j = 0; j < winLen; j++) dist += Math.abs(history[i + j] - current[j]);
        candidates.push({ dist, next: history[i + winLen] });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    const kNearest = candidates.slice(0, k);
    if (kNearest.length === 0) return { scores: normaliseScores(scores), confidence: 0, name: 'knn', tier: 1 };

    const maxDist = kNearest[kNearest.length - 1].dist || 1;
    const weightSum = kNearest.reduce((sum, item) => sum + (maxDist - item.dist + 1), 0);
    kNearest.forEach(({ dist, next }) => {
        if (next >= 0 && next <= 9) scores[next] += (maxDist - dist + 1) / weightSum;
    });

    return { scores: normaliseScores(scores), confidence: Math.max(...scores), name: 'knn', tier: 1 };
}

// ── 5. Multi-Window Adaptive Momentum ──────────────────────────────────────
function adaptiveMomentumStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    const windows = [3, 5, 8, 12, 20];
    if (history.length < Math.max(...windows)) return { scores: normaliseScores(scores), confidence: 0, name: 'adaptiveMomentum', tier: 1 };

    windows.forEach((w, wi) => {
        const slice = history.slice(-w);
        const freq = Array(10).fill(0) as number[];
        slice.forEach(d => { if (d >= 0 && d <= 9) freq[d]++; });
        const total = slice.length;
        const weight = (windows.length - wi) * 1.5;
        freq.forEach((c, i) => { scores[i] += (c / total) * weight; });
    });

    return { scores: normaliseScores(scores), confidence: Math.max(...normaliseScores(scores)), name: 'adaptiveMomentum', tier: 1 };
}

// ── 6. Digit Acceleration with multiple timeframes ────────────────────────
function digitAccelerationStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    const windows = [10, 20, 30, 50];
    if (history.length < 20) return { scores: normaliseScores(scores), confidence: 0, name: 'acceleration', tier: 2 };

    windows.forEach((windowSize, idx) => {
        const window = history.slice(-windowSize);
        if (window.length < 10) return;
        const half = Math.floor(window.length / 2);
        if (half === 0) return;

        const countInWindow = (start: number, end: number, digit: number) =>
            window.slice(start, end).filter(d => d === digit).length;

        for (let d = 0; d <= 9; d++) {
            const oldVelocity = countInWindow(0, half, d) / half;
            const newVelocity = countInWindow(half, window.length, d) / (window.length - half);
            const acceleration = newVelocity - oldVelocity;
            const weight = 1 / (idx + 1);
            scores[d] += Math.max(0, acceleration) * weight;
        }
    });

    return { scores: normaliseScores(scores), confidence: Math.max(...normaliseScores(scores)), name: 'acceleration', tier: 2 };
}

// ── 7. Hot-Cold with recency weighting ─────────────────────────────────────
function hotColdDigitStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    const windows = [10, 20, 50];
    if (windows[0] === 0) return { scores: normaliseScores(scores), confidence: 0, name: 'hotCold', tier: 2 };

    windows.forEach((windowSize, idx) => {
        const recent = history.slice(-windowSize);
        const freq = Array(10).fill(0) as number[];
        recent.forEach(d => { if (d >= 0 && d <= 9) freq[d]++; });
        const weight = 1 / (idx + 1);
        
        freq.forEach((c, i) => {
            if (c >= 4) scores[i] += c * 4 * weight;
            else if (c >= 3) scores[i] += c * 2 * weight;
            else if (c >= 2) scores[i] += c * 1.5 * weight;
            else scores[i] += c * weight;
        });
    });

    return { scores: normaliseScores(scores), confidence: Math.max(...normaliseScores(scores)), name: 'hotCold', tier: 2 };
}

// ── 8. Enhanced Bayesian with decay ────────────────────────────────────────
function bayesianProbabilityStrategy(history: number[]): StrategyResult {
    const priors = Array(10).fill(0.1) as number[];
    if (history.length === 0) return { scores: normaliseScores(priors), confidence: 0.1, name: 'bayesian', tier: 2 };

    const posteriors = [...priors];
    const decayFactor = 0.8;
    let weight = 1;

    for (let i = history.length - 1; i >= 0; i--) {
        const d = history[i];
        if (d >= 0 && d <= 9) posteriors[d] += weight;
        weight *= decayFactor;
    }

    return { scores: normaliseScores(posteriors), confidence: Math.max(...normaliseScores(posteriors)), name: 'bayesian', tier: 2 };
}

// ── 9. Recency-Weighted Entropy Analysis ─────────────────────────────────
function entropyStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    const windowSize = Math.min(100, history.length);
    if (windowSize === 0) return { scores: normaliseScores(scores), confidence: 0, name: 'entropy', tier: 3 };

    const slice = history.slice(-windowSize);
    const freq = Array(10).fill(0) as number[];
    slice.forEach((d, idx) => { 
        if (d >= 0 && d <= 9) {
            const recency = 1 - (idx / windowSize);
            freq[d] += 1 + recency;
        }
    });

    let entropy = 0;
    const total = freq.reduce((a, b) => a + b, 0);
    freq.forEach(c => {
        if (c > 0) { const p = c / total; entropy -= p * Math.log2(p); }
    });

    const maxEntropy = Math.log2(10);
    const normEntropy = entropy / maxEntropy;

    if (normEntropy < 0.5) {
        freq.forEach((c, i) => { scores[i] = c; });
    } else {
        const sorted = [...freq].sort((a, b) => a - b);
        const median = sorted[5];
        freq.forEach((c, i) => { scores[i] = Math.abs(c - median) < 3 ? 1.5 : 0.5; });
    }

    return { scores: normaliseScores(scores), confidence: 1 - normEntropy, name: 'entropy', tier: 3 };
}

// ── 10. Digit Repetition with recency ────────────────────────────────────
function digitRepetitionStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    if (history.length === 0) return { scores: normaliseScores(scores), confidence: 0, name: 'digitRepeat', tier: 2 };

    const recentLen = Math.min(100, history.length);
    const recent = history.slice(-recentLen);

    recent.forEach((d, idx) => {
        if (d >= 0 && d <= 9) {
            const recency = (idx + 1) / recentLen;
            scores[d] += recency * recency * 2;
        }
    });

    return { scores: normaliseScores(scores), confidence: Math.max(...normaliseScores(scores)), name: 'digitRepeat', tier: 2 };
}

// ── 11. Consecutive Digit Pattern Detection ─────────────────────────────
function consecutivePatternStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    if (history.length < 5) return { scores: normaliseScores(scores), confidence: 0, name: 'consecutive', tier: 2 };

    const patterns: Record<string, number> = {};
    for (let i = 2; i <= 5; i++) {
        if (history.length < i) continue;
        const key = history.slice(-i).join(',');
        const next = history[history.length - 1];
        if (!patterns[key]) patterns[key] = 0;
        patterns[key]++;
    }

    for (let i = 0; i <= history.length - 3; i++) {
        const seq = [history[i], history[i+1], history[i+2]];
        const isUp = seq[1] > seq[0] && seq[2] > seq[1];
        const isDown = seq[1] < seq[0] && seq[2] < seq[1];
        if (isUp || isDown) {
            const last = history[history.length - 1];
            if (isUp && last < 9) scores[last + 1] += 0.5;
            if (isDown && last > 0) scores[last - 1] += 0.5;
        }
    }

    return { scores: normaliseScores(scores), confidence: Math.max(...scores) * 0.7, name: 'consecutive', tier: 2 };
}

// ── 12. Pair Frequency Analysis ─────────────────────────────────────────
function pairFrequencyStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    if (history.length < 3) return { scores: normaliseScores(scores), confidence: 0, name: 'pairs', tier: 2 };

    const pairCounts: Record<string, number> = {};
    for (let i = 0; i < history.length - 1; i++) {
        const pair = `${history[i]}-${history[i+1]}`;
        pairCounts[pair] = (pairCounts[pair] || 0) + 1;
    }

    const last = history[history.length - 1];
    Object.entries(pairCounts).forEach(([pair, count]) => {
        if (pair.startsWith(`${last}-`)) {
            const nextDigit = parseInt(pair.split('-')[1], 10);
            if (nextDigit >= 0 && nextDigit <= 9) {
                scores[nextDigit] += count;
            }
        }
    });

    return { scores: normaliseScores(scores), confidence: Math.max(...scores) / 10, name: 'pairs', tier: 2 };
}

// ── 13. Gap Analysis (distance between same digits) ─────────────────────
function gapAnalysisStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    if (history.length < 10) return { scores: normaliseScores(scores), confidence: 0, name: 'gap', tier: 2 };

    const lastPositions: number[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
        if (lastPositions.length >= 2) break;
        if (history[i] === history[history.length - 1]) {
            const gap = history.length - 1 - i;
            lastPositions.push(gap);
        }
    }

    if (lastPositions.length >= 2) {
        const avgGap = (lastPositions[0] + lastPositions[1]) / 2;
        const expectedPos = history.length - 1 + avgGap;
        
        for (let d = 0; d <= 9; d++) {
            let count = 0;
            for (let i = 0; i < history.length - 1; i++) {
                if (history[i] === d && history[i+1] === d) count++;
            }
            if (count > 0) {
                const lastIdx = history.lastIndexOf(d);
                const gap = history.length - 1 - lastIdx;
                if (gap >= avgGap * 0.7 && gap <= avgGap * 1.3) {
                    scores[d] += count * 0.5;
                }
            }
        }
    }

    return { scores: normaliseScores(scores), confidence: Math.max(...scores) * 0.5, name: 'gap', tier: 3 };
}

// ── 14. Digit Distribution Balance ────────────────────────────────────────
function distributionBalanceStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    const window = Math.min(50, history.length);
    if (window < 20) return { scores: normaliseScores(scores), confidence: 0, name: 'distribution', tier: 3 };

    const recent = history.slice(-window);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    const last = history[history.length - 1];
    for (let d = 0; d <= 9; d++) {
        const deviation = Math.abs(d - mean);
        scores[d] = Math.max(0, (stdDev - deviation) / stdDev);
    }

    return { scores: normaliseScores(scores), confidence: Math.min(stdDev / 5, 1), name: 'distribution', tier: 3 };
}

// ── 15. Trend Following Strategy ─────────────────────────────────────────
function trendFollowingStrategy(history: number[]): StrategyResult {
    const scores = Array(10).fill(0) as number[];
    if (history.length < 5) return { scores: normaliseScores(scores), confidence: 0, name: 'trend', tier: 2 };

    let upCount = 0, downCount = 0;
    for (let i = 1; i < history.length; i++) {
        if (history[i] > history[i-1]) upCount++;
        else if (history[i] < history[i-1]) downCount++;
    }

    const trend = upCount > downCount ? 1 : (downCount > upCount ? -1 : 0);
    const last = history[history.length - 1];

    if (trend === 1 && last < 9) scores[last + 1] += 3;
    else if (trend === -1 && last > 0) scores[last - 1] += 3;
    else scores[last] += 1;

    return { scores: normaliseScores(scores), confidence: Math.abs(upCount - downCount) / history.length, name: 'trend', tier: 2 };
}

// ── MAIN ENGINE ────────────────────────────────────────────────────────────
export function predictNextDigits(history: number[]): PredictionResult {
    if (history.length < 5) {
        return {
            top4Digits: [],
            rankedDigits: [],
            overallConfidence: 0,
            summary: 'Insufficient history for prediction',
            predictedDigit: null,
        };
    }

    // ── 21. Immediate Next Tick Strategy ─────────────────────────────────────
    function immediateNextTickStrategy(history: number[]): StrategyResult {
        const scores = Array(10).fill(0) as number[];
        if (history.length < 5) return { scores: normaliseScores(scores), confidence: 0, name: 'immediate', tier: 1 };

        const last3 = history.slice(-3);
        const last5 = history.slice(-5);
        
        const pattern1 = last3.join(',');
        const counts1: Record<string, number> = {};
        for (let i = 0; i <= history.length - 4; i++) {
            const key = history.slice(i, i + 3).join(',');
            counts1[key] = (counts1[key] || 0) + 1;
        }
        if (counts1[pattern1]) {
            for (let i = 0; i <= history.length - 4; i++) {
                if (history.slice(i, i + 3).join(',') === pattern1) {
                    const next = history[i + 3];
                    if (next >= 0 && next <= 9) scores[next] += counts1[pattern1] * 3;
                }
            }
        }

        const last = history[history.length - 1];
        const secondLast = history[history.length - 2];
        
        for (let i = 1; i < history.length - 1; i++) {
            if (history[i] === secondLast && history[i-1] === last) {
                const next = history[i + 1];
                if (next >= 0 && next <= 9) scores[next] += 2;
            }
        }

        const reverseLast3 = [...last3].reverse().join(',');
        const countsReverse: Record<string, number> = {};
        for (let i = 0; i <= history.length - 4; i++) {
            const key = [...history.slice(i, i + 3)].reverse().join(',');
            countsReverse[key] = (countsReverse[key] || 0) + 1;
        }
        if (countsReverse[reverseLast3]) {
            const targetPattern = [...last3].reverse().join(',');
            for (let i = 0; i <= history.length - 4; i++) {
                const revSlice = [...history.slice(i, i + 3)].reverse().join(',');
                if (revSlice === targetPattern) {
                    const next = history[i + 3];
                    if (next >= 0 && next <= 9) scores[next] += countsReverse[reverseLast3] * 2;
                }
            }
        }

        return { scores: normaliseScores(scores), confidence: Math.max(...scores) / 10, name: 'immediate', tier: 1 };
    }

    const strategies: StrategyResult[] = [
        nGramStrategy(history, 1),
        nGramStrategy(history, 2),
        nGramStrategy(history, 3),
        nGramStrategy(history, 4),
        markovChainStrategy(history),
        cyclicalPatternStrategy(history),
        knnPatternStrategy(history, 7, 2),
        knnPatternStrategy(history, 7, 3),
        knnPatternStrategy(history, 7, 4),
        adaptiveMomentumStrategy(history),
        digitAccelerationStrategy(history),
        hotColdDigitStrategy(history),
        bayesianProbabilityStrategy(history),
        entropyStrategy(history),
        digitRepetitionStrategy(history),
        consecutivePatternStrategy(history),
        pairFrequencyStrategy(history),
        gapAnalysisStrategy(history),
        distributionBalanceStrategy(history),
        trendFollowingStrategy(history),
        immediateNextTickStrategy(history),
    ];

    const combined = Array(10).fill(0) as number[];
    let totalWeight = 0;
    let tier1Consensus = Array(10).fill(0) as number[];
    let tier1Count = 0;
    let tier2Consensus = Array(10).fill(0) as number[];
    let tier2Count = 0;

    strategies.forEach(s => {
        const baseWeight = TIER_WEIGHT[s.tier];
        const confidenceWeight = 0.5 + s.confidence * 0.5;
        const weight = baseWeight * confidenceWeight;

        s.scores.forEach((score, digit) => { combined[digit] += score * weight; });
        totalWeight += weight;

        if (s.tier === 1 && s.confidence > 0.12) {
            s.scores.forEach((score, digit) => { tier1Consensus[digit] += score; });
            tier1Count++;
        } else if (s.tier === 2 && s.confidence > 0.15) {
            s.scores.forEach((score, digit) => { tier2Consensus[digit] += score; });
            tier2Count++;
        }
    });

    if (totalWeight > 0) combined.forEach((_, i) => { combined[i] /= totalWeight; });

    if (tier1Count > 0) {
        const t1max = Math.max(...tier1Consensus);
        if (t1max > 0) {
            tier1Consensus = tier1Consensus.map(s => s / t1max);
            combined.forEach((_, i) => { combined[i] += tier1Consensus[i] * 0.4; });
        }
    }

    if (tier2Count > 0) {
        const t2max = Math.max(...tier2Consensus);
        if (t2max > 0) {
            tier2Consensus = tier2Consensus.map(s => s / t2max);
            combined.forEach((_, i) => { combined[i] += tier2Consensus[i] * 0.2; });
        }
    }

    const final = normaliseScores(combined);

    // ── Enhanced Recency: weight last 1-2 ticks much heavier for 1-tick contracts ──
    const last1 = history[history.length - 1];
    const last2 = history[history.length - 2];
    const last3 = history[history.length - 3];

    const recencyBoost = Array(10).fill(0) as number[];

    // Last 1 tick: massive weight (this is what we're predicting FROM)
    if (last1 >= 0 && last1 <= 9) recencyBoost[last1] += 15.0;

    // Last 2 ticks: strong weight
    if (last2 >= 0 && last2 <= 9) recencyBoost[last2] += 8.0;

    // Last 3 ticks
    if (last3 >= 0 && last3 <= 9) recencyBoost[last3] += 5.0;

    // Last 5 ticks
    const last5Freq = getRecentFrequency(history, 5);
    last5Freq.forEach((count, digit) => {
        if (count > 0) recencyBoost[digit] += count * 3.0;
    });

    // Last 10 ticks
    const last10Freq = getRecentFrequency(history, 10);
    last10Freq.forEach((count, digit) => {
        if (count > 0) recencyBoost[digit] += count * 1.5;
    });

    // Transition analysis: what digit follows the current sequence most often
    const last3Key = history.slice(-3).join(',');
    const transitions: Record<string, number[]> = {};
    for (let i = 0; i <= history.length - 4; i++) {
        const key = history.slice(i, i + 3).join(',');
        if (!transitions[key]) transitions[key] = Array(10).fill(0);
        transitions[key][history[i + 3]]++;
    }
    if (transitions[last3Key]) {
        const total = transitions[last3Key].reduce((a, b) => a + b, 0);
        if (total > 0) {
            transitions[last3Key].forEach((count, digit) => {
                recencyBoost[digit] += (count / total) * 20.0;
            });
        }
    }

    // Cycle detection: find repeating patterns and predict next
    for (let cycleLen = 2; cycleLen <= 6; cycleLen++) {
        if (history.length < cycleLen * 3) continue;
        const recent = history.slice(-cycleLen * 3);
        let matches = 0;
        for (let i = cycleLen; i < recent.length; i++) {
            if (recent[i] === recent[i - cycleLen]) matches++;
        }
        const matchRate = matches / (recent.length - cycleLen);
        if (matchRate > 0.5) {
            const nextInCycle = history[history.length - cycleLen];
            if (nextInCycle >= 0 && nextInCycle <= 9) {
                recencyBoost[nextInCycle] += matchRate * 12.0;
            }
        }
    }

    const recencySum = recencyBoost.reduce((a, b) => a + b, 0);
    if (recencySum > 0) {
        const recencyNorm = recencyBoost.map(v => v / recencySum);
        final.forEach((score, digit) => {
            final[digit] = score * 0.4 + recencyNorm[digit] * 0.6;
        });
    }

    const rankedDigits = final
        .map((score, digit) => ({ digit, score }))
        .sort((a, b) => b.score - a.score);

    const top4Digits = rankedDigits.slice(0, 4).map(d => d.digit);
    const predictedDigit = rankedDigits[0].digit;

    const topScore = rankedDigits[0].score;
    const secondScore = rankedDigits[1].score;
    const dominance = topScore - secondScore;
    const tier1AgreementCount = strategies.filter(s => s.tier === 1 && s.scores[rankedDigits[0].digit] === Math.max(...s.scores)).length;
    const tier2AgreementCount = strategies.filter(s => s.tier === 2 && s.scores[rankedDigits[0].digit] === Math.max(...s.scores)).length;

    // Stricter confidence: weighted by dominance, strategy agreement, and raw score
    const dominanceConf = Math.min(dominance * 20, 0.4);
    const tier1Conf = Math.min(tier1AgreementCount * 0.06, 0.3);
    const tier2Conf = Math.min(tier2AgreementCount * 0.03, 0.15);
    const rawScoreConf = Math.min(topScore * 0.5, 0.15);
    const overallConfidence = Math.min(dominanceConf + tier1Conf + tier2Conf + rawScoreConf, 1);

    const top4Str = rankedDigits.slice(0, 4).map(d => `${d.digit}(${(d.score * 100).toFixed(0)}%)`).join(' ');
    const summary = `Predict NEXT tick: ${predictedDigit} (${(rankedDigits[0].score * 100).toFixed(0)}%), Top4: [${top4Str}], Conf:${(overallConfidence * 100).toFixed(0)}%`;

    return { top4Digits, rankedDigits, overallConfidence, summary, predictedDigit };
}
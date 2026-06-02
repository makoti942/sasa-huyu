import React, { useEffect, useRef, useState } from 'react';
import { Scanner } from './scanner';
import { MarketKiller } from './market-killer';
import './makoti-widget.scss';

type Tab = 'scanner' | 'market_killer';
const PAD = 8;

export const MakotiWidget: React.FC = () => {
    const [open, setOpen]         = useState(() => localStorage.getItem('mw_open') === 'true');
    const [tab, setTab]           = useState<Tab>(() => (localStorage.getItem('mw_tab') as Tab) || 'scanner');
    const [minimized, setMinimized] = useState(false);

    /* ── FAB position (refs for zero-rerender drag) ─────────── */
    const btnPosRef = useRef({ x: Math.max(PAD, window.innerWidth - 88), y: Math.max(PAD, window.innerHeight - 108) });
    const winPosRef = useRef({ x: Math.max(PAD, window.innerWidth - 420), y: Math.max(PAD, window.innerHeight - 640) });

    /* ── Persist open / tab state to localStorage ─────────── */
    useEffect(() => { localStorage.setItem('mw_open', String(open)); }, [open]);
    useEffect(() => { localStorage.setItem('mw_tab',  tab);          }, [tab]);

    /* ── Drag state (refs, never cause re-renders) ─────────── */
    const btnDragging  = useRef(false);
    const winDragging  = useRef(false);
    const miniDragging = useRef(false);
    const btnMoved     = useRef(false);
    const winMoved     = useRef(false);
    const startClient  = useRef({ x: 0, y: 0 });
    const startElem    = useRef({ x: 0, y: 0 });
    const rafId        = useRef<number | null>(null);

    const btnRef  = useRef<HTMLButtonElement>(null);
    const winRef  = useRef<HTMLDivElement>(null);
    const miniRef = useRef<HTMLButtonElement>(null);

    /* ── Shared global pointer handlers (transform-based for GPU-composited drag) ── */
    useEffect(() => {
        let pendingDx = 0, pendingDy = 0;
        let hasPending = false;

        const w = window.innerWidth;
        const h = window.innerHeight;
        const isMobile = w <= 600;
        const winW = Math.min(isMobile ? 250 : 300, w - PAD * 2);

        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

        const applyDrag = () => {
            rafId.current = null;

            if (btnDragging.current && btnRef.current) {
                const baseX = startElem.current.x;
                const baseY = startElem.current.y;
                const nx = clamp(baseX + pendingDx, PAD, w - 72 - PAD);
                const ny = clamp(baseY + pendingDy, PAD, h - 72 - PAD);
                btnRef.current.style.transform = `translate(${nx - baseX}px, ${ny - baseY}px)`;
                btnPosRef.current = { x: nx, y: ny };
            }
            if (winDragging.current && winRef.current) {
                const baseX = startElem.current.x;
                const baseY = startElem.current.y;
                const nx = clamp(baseX + pendingDx, PAD, w - winW - PAD);
                const ny = clamp(baseY + pendingDy, PAD, h - 60);
                winRef.current.style.transform = `translate(${nx - baseX}px, ${ny - baseY}px)`;
                winPosRef.current = { x: nx, y: ny };
            }
            if (miniDragging.current && miniRef.current) {
                const baseX = startElem.current.x;
                const baseY = startElem.current.y;
                const nx = clamp(baseX + pendingDx, PAD, w - 44 - PAD);
                const ny = clamp(baseY + pendingDy, PAD, h - 44 - PAD);
                miniRef.current.style.transform = `translate(${nx - baseX}px, ${ny - baseY}px)`;
                winPosRef.current = { x: nx, y: ny };
            }
            hasPending = false;
        };

        const onMove = (e: PointerEvent) => {
            if (!btnDragging.current && !winDragging.current && !miniDragging.current) return;
            const dx = e.clientX - startClient.current.x;
            const dy = e.clientY - startClient.current.y;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                btnMoved.current = true;
                winMoved.current = true;
            }
            pendingDx = dx;
            pendingDy = dy;
            if (!hasPending) {
                hasPending = true;
                rafId.current = requestAnimationFrame(applyDrag);
            }
        };

        const onUp = () => {
            const wasBtn  = btnDragging.current;
            const wasWin  = winDragging.current;
            const wasMini = miniDragging.current;

            btnDragging.current  = false;
            winDragging.current  = false;
            miniDragging.current = false;

            if (rafId.current !== null) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
            }

            if (wasBtn && btnRef.current) {
                btnRef.current.style.transform = 'none';
                btnRef.current.style.left = btnPosRef.current.x + 'px';
                btnRef.current.style.top  = btnPosRef.current.y + 'px';
            }
            if (wasWin && winRef.current) {
                winRef.current.style.transform = 'none';
                winRef.current.style.left = winPosRef.current.x + 'px';
                winRef.current.style.top  = winPosRef.current.y + 'px';
            }
            if (wasMini && miniRef.current) {
                miniRef.current.style.transform = 'none';
                miniRef.current.style.left = winPosRef.current.x + 'px';
                miniRef.current.style.top  = winPosRef.current.y + 'px';
            }
        };

        document.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerup',   onUp);
        return () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup',   onUp);
            if (rafId.current !== null) cancelAnimationFrame(rafId.current);
        };
    }, []);

    /* ── Set initial positions via refs on first render ─────── */
    useEffect(() => {
        if (btnRef.current) {
            btnRef.current.style.left = btnPosRef.current.x + 'px';
            btnRef.current.style.top  = btnPosRef.current.y + 'px';
        }
    }, []);

    useEffect(() => {
        if (winRef.current && open) {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const isMob = w <= 600;
            const defX = Math.max(PAD, w - Math.min(isMob ? 250 : 300, w - PAD * 2) - PAD);
            const defY = Math.max(PAD, h - (isMob ? 380 : 460));
            winRef.current.style.left = (isMob ? PAD : defX) + 'px';
            winRef.current.style.top  = (w <= 600 ? PAD : defY) + 'px';
        }
    }, [open]);

    /* ── FAB pointer down ─────────────────────────────────── */
    const onBtnPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        btnDragging.current = true;
        btnMoved.current    = false;
        startClient.current = { x: e.clientX, y: e.clientY };
        startElem.current   = { ...btnPosRef.current };
    };

    /* ── FAB click — only toggle if not a drag ────────────── */
    const onBtnClick = () => {
        if (btnMoved.current) { btnMoved.current = false; return; }
        setOpen(o => !o);
    };

    /* ── Window header pointer down ───────────────────────── */
    const onWinPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (
            target.closest('.mw-win-body')    ||
            target.closest('.mw-win-actions') ||
            target.closest('.mw-tabs')        ||
            target.tagName === 'BUTTON' ||
            target.tagName === 'INPUT'  ||
            target.tagName === 'SELECT'
        ) return;
        e.preventDefault();
        winDragging.current = true;
        winMoved.current    = false;
        startClient.current = { x: e.clientX, y: e.clientY };
        startElem.current   = { ...winPosRef.current };
    };

    /* ── Window initial position (computed inline, no flash) ── */
    const initWinStyle = (() => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (w <= 600) return { left: PAD, top: PAD };
        return {
            left: Math.max(PAD, w - Math.min(400, w - PAD * 2) - PAD),
            top: Math.max(PAD, h - 640),
        };
    })();

    return (
        <>
            {/* ── Floating button ── */}
            <button
                ref={btnRef}
                className={`mw-fab${open ? ' mw-fab--open' : ''}`}
                style={{ position: 'fixed', left: btnPosRef.current.x, top: btnPosRef.current.y, zIndex: 100001 }}
                onPointerDown={onBtnPointerDown}
                onClick={onBtnClick}
                title='MAKOTI — Scanner & Market Killer'
            >
                <span className='mw-fab__pulse' />
                <span className='mw-fab__icon'>⚔</span>
                <span className='mw-fab__label'>MAKOTI</span>
            </button>

            {/* ── Floating window (draggable, same on all devices) ── */}
            {open && (
                <>
                    <div
                        ref={winRef}
                        className={`mw-window${minimized ? ' mw-window--hidden' : ''}`}
                        style={{ position: 'fixed', left: initWinStyle.left + 'px', top: initWinStyle.top + 'px' }}
                        onPointerDown={onWinPointerDown}
                    >
                        <div className='mw-win-header'>
                            <div className='mw-win-title'>
                                <span className='mw-win-logo'>⚔</span>
                                <span>MAKOTI</span>
                            </div>
                            <div className='mw-win-actions'>
                                <button
                                    className='mw-win-action'
                                    onClick={() => setMinimized(m => !m)}
                                    title='Minimize'
                                >
                                    ▼
                                </button>
                                <button
                                    className='mw-win-action mw-win-action--close'
                                    onClick={() => setOpen(false)}
                                    title='Close'
                                >
                                    ×
                                </button>
                            </div>
                        </div>

                        <div className='mw-tabs'>
                            <button
                                className={`mw-tab${tab === 'scanner' ? ' mw-tab--active' : ''}`}
                                onClick={() => setTab('scanner')}
                            >
                                Scanner
                            </button>
                            <button
                                className={`mw-tab${tab === 'market_killer' ? ' mw-tab--active' : ''}`}
                                onClick={() => setTab('market_killer')}
                            >
                                Market Killer
                            </button>
                        </div>

                        <div className='mw-win-body'>
                            {tab === 'scanner' ? <Scanner /> : <MarketKiller />}
                        </div>
                    </div>

                    {minimized && (
                        <button
                            ref={miniRef}
                            className='mw-mini'
                            style={{
                                position: 'fixed',
                                left: winPosRef.current.x,
                                top: winPosRef.current.y,
                                zIndex: 99998,
                            }}
                            onPointerDown={(e) => {
                                miniDragging.current = true;
                                winMoved.current = false;
                                startClient.current = { x: e.clientX, y: e.clientY };
                                startElem.current = { ...winPosRef.current };
                                e.preventDefault();
                            }}
                            onClick={() => {
                                if (winMoved.current) { winMoved.current = false; return; }
                                setMinimized(false);
                            }}
                        >
                            ⚔
                        </button>
                    )}
                </>
            )}
        </>
    );
};

export default MakotiWidget;

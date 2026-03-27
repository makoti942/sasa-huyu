import React, { useState, useEffect } from 'react';
import { Localize, localize } from '@deriv-com/translations';
import OverUnderStrategy from './strategies/over-under-strategy';
import OddStrategy from './strategies/odd-strategy';
import EvenStrategy from './strategies/even-strategy';
import HitAndRunStrategy from './strategies/hit-and-run-strategy';
import './strategies.scss';

type StrategySubTab = 'over-under' | 'odd' | 'even' | 'hit-and-run' | null;

const Strategies: React.FC = () => {
    const [active_strategy, setActiveStrategy] = useState<StrategySubTab>(null);

    // Enable scrolling on parent tab content
    useEffect(() => {
        const enableScrolling = () => {
            // Method 1: Find by strategies element
            const strategiesElement = document.querySelector('.strategies--standalone') || 
                                     document.querySelector('.strategies');
            if (strategiesElement) {
                // Find the closest tab content parent
                let parent = strategiesElement.parentElement;
                let depth = 0;
                while (parent && !parent.classList.contains('dc-tabs__content') && depth < 10) {
                    parent = parent.parentElement;
                    depth++;
                }
                
                if (parent) {
                    parent.classList.add('strategies-tab-active');
                    const parentEl = parent as HTMLElement;
                    parentEl.style.overflowY = 'auto';
                    parentEl.style.overflowX = 'hidden';
                    parentEl.style.webkitOverflowScrolling = 'touch';
                    // Ensure it can scroll past the viewport
                    parentEl.style.height = 'calc(100vh - 3.5rem - 6rem)';
                    parentEl.style.maxHeight = 'calc(100vh - 3.5rem - 6rem)';
                }
            }
            
            // Method 2: Find all tab contents and check which one contains strategies
            const allTabContents = document.querySelectorAll('.dc-tabs__content');
            allTabContents.forEach((tabContent) => {
                const hasStrategies = tabContent.querySelector('.strategies--standalone') || 
                                     tabContent.querySelector('.strategies');
                if (hasStrategies) {
                    tabContent.classList.add('strategies-tab-active');
                    const tabEl = tabContent as HTMLElement;
                    tabEl.style.overflowY = 'auto';
                    tabEl.style.overflowX = 'hidden';
                    tabEl.style.webkitOverflowScrolling = 'touch';
                    // Ensure it can scroll past the viewport
                    tabEl.style.height = 'calc(100vh - 3.5rem - 6rem)';
                    tabEl.style.maxHeight = 'calc(100vh - 3.5rem - 6rem)';
                }
            });
        };

        // Run immediately
        enableScrolling();
        
        // Also run after delays to ensure DOM is ready
        const timeoutId1 = setTimeout(enableScrolling, 100);
        const timeoutId2 = setTimeout(enableScrolling, 500);
        
        return () => {
            clearTimeout(timeoutId1);
            clearTimeout(timeoutId2);
            const allTabContents = document.querySelectorAll('.dc-tabs__content');
            allTabContents.forEach((tabContent) => {
                tabContent.classList.remove('strategies-tab-active');
                const tabEl = tabContent as HTMLElement;
                tabEl.style.overflowY = '';
                tabEl.style.overflowX = '';
                tabEl.style.height = '';
                tabEl.style.maxHeight = '';
            });
        };
    }, []);

    const handleExploreClick = (strategy: StrategySubTab) => {
        setActiveStrategy(strategy);
    };

    const handleBackClick = () => {
        setActiveStrategy(null);
    };

    const renderContent = () => {
        if (!active_strategy) return null;

        switch (active_strategy) {
            case 'over-under':
                return <OverUnderStrategy onBack={handleBackClick} />;
            case 'odd':
                return <OddStrategy onBack={handleBackClick} />;
            case 'even':
                return <EvenStrategy onBack={handleBackClick} />;
            case 'hit-and-run':
                return <HitAndRunStrategy onBack={handleBackClick} />;
            default:
                return null;
        }
    };

    // Icon components
    const OverUnderIcon = ({ fill }: { fill: string }) => (
        <svg width='32' height='32' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path
                d='M2 12L6 8L9 11L14 6'
                stroke={fill}
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
            />
            <path d='M14 6H10V10' stroke={fill} strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
        </svg>
    );

    const OddIcon = ({ fill }: { fill: string }) => (
        <svg width='32' height='32' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <rect x='2' y='3' width='12' height='10' rx='1' stroke={fill} strokeWidth='1.5' fill='none' />
            <path d='M5 6H11M5 10H11' stroke={fill} strokeWidth='1.5' strokeLinecap='round' />
            <circle cx='8' cy='8' r='1' fill={fill} />
        </svg>
    );

    const EvenIcon = ({ fill }: { fill: string }) => (
        <svg width='32' height='32' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <rect x='2' y='3' width='12' height='10' rx='1' stroke={fill} strokeWidth='1.5' fill='none' />
            <path d='M5 6H11M5 10H11' stroke={fill} strokeWidth='1.5' strokeLinecap='round' />
            <circle cx='6.5' cy='8' r='0.5' fill={fill} />
            <circle cx='9.5' cy='8' r='0.5' fill={fill} />
        </svg>
    );

    const HitAndRunIcon = ({ fill }: { fill: string }) => (
        <svg width='32' height='32' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path
                d='M8 2L3 7H7V14H9V7H13L8 2Z'
                fill={fill}
            />
        </svg>
    );

    if (active_strategy) {
        return (
            <div className='strategies strategies--standalone'>
                <div className='strategies__content'>{renderContent()}</div>
            </div>
        );
    }

    return (
        <div className='strategies strategies--standalone'>
            <h1 className='strategies__heading'>
                <Localize i18n_default_text='Advanced Trading Strategies' />
            </h1>
            <p className='strategies__subtitle'>
                <Localize i18n_default_text='Select a trading strategy to view detailed execution guidelines.' />
            </p>
            <div className='strategies__cards-container'>
                <div className='strategies__card strategies__card--light'>
                    <div className='strategies__card-content'>
                        <div className='strategies__card-icon'>
                            <OverUnderIcon fill='#3b82f6' />
                        </div>
                        <h3 className='strategies__card-title'>
                            <Localize i18n_default_text='Over/Under' />
                        </h3>
                        <p className='strategies__card-description'>
                            <Localize i18n_default_text='Predict if price will finish above or below target' />
                        </p>
                        <button
                            className='strategies__card-button'
                            onClick={() => handleExploreClick('over-under')}
                        >
                            <Localize i18n_default_text='Explore Strategy' />
                            <svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                                <path d='M5 12H19M19 12L12 5M19 12L12 19' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                            </svg>
                        </button>
                    </div>
                </div>
                <div className='strategies__card strategies__card--light'>
                    <div className='strategies__card-content'>
                        <div className='strategies__card-icon'>
                            <OddIcon fill='#ec4899' />
                        </div>
                        <h3 className='strategies__card-title'>
                            <Localize i18n_default_text='Odd' />
                        </h3>
                        <p className='strategies__card-description'>
                            <Localize i18n_default_text='Forecast whether the final digit will be odd' />
                        </p>
                        <button
                            className='strategies__card-button'
                            onClick={() => handleExploreClick('odd')}
                        >
                            <Localize i18n_default_text='Explore Strategy' />
                            <svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                                <path d='M5 12H19M19 12L12 5M19 12L12 19' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                            </svg>
                        </button>
                    </div>
                </div>
                <div className='strategies__card strategies__card--light'>
                    <div className='strategies__card-content'>
                        <div className='strategies__card-icon'>
                            <EvenIcon fill='#10b981' />
                        </div>
                        <h3 className='strategies__card-title'>
                            <Localize i18n_default_text='Even' />
                        </h3>
                        <p className='strategies__card-description'>
                            <Localize i18n_default_text='Forecast whether the final digit will be even' />
                        </p>
                        <button
                            className='strategies__card-button'
                            onClick={() => handleExploreClick('even')}
                        >
                            <Localize i18n_default_text='Explore Strategy' />
                            <svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                                <path d='M5 12H19M19 12L12 5M19 12L12 19' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                            </svg>
                        </button>
                    </div>
                </div>
                <div className='strategies__card strategies__card--light strategies__card--hit-and-run'>
                    <div className='strategies__card-content'>
                        <div className='strategies__card-icon'>
                            <HitAndRunIcon fill='#ef4444' />
                        </div>
                        <button
                            className='strategies__card-button strategies__card-button--top'
                            onClick={() => handleExploreClick('hit-and-run')}
                        >
                            <Localize i18n_default_text='Explore Strategy' />
                            <svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                                <path d='M5 12H19M19 12L12 5M19 12L12 19' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                            </svg>
                        </button>
                        <h3 className='strategies__card-title'>
                            <Localize i18n_default_text='Hit and Run' />
                        </h3>
                        <p className='strategies__card-description'>
                            <Localize i18n_default_text='Quick entry and exit strategy for fast profits' />
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Strategies;

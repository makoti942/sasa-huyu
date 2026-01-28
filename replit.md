# Smart Trading Hub (Makoti Traders)

## Overview
A React-based trading bot platform built with Rsbuild. Features include automated trading bots, AI-powered analysis, copy trading, and trading signals.

## Tech Stack
- **Frontend**: React 18 with TypeScript
- **Build Tool**: Rsbuild (RSPack-based bundler)
- **Styling**: SASS/SCSS
- **State Management**: MobX
- **UI Components**: Deriv Quill UI, Blockly for visual bot building

## Project Structure
- `src/` - Main source code
  - `components/` - React components
  - `stores/` - MobX stores
  - `hooks/` - Custom React hooks
  - `utils/` - Utility functions
  - `constants/` - Application constants
- `public/` - Static assets and standalone tools
- `index.html` - Main HTML template

## Development
- **Dev Server**: `npm run start` - Runs on port 5000
- **Build**: `npm run build` - Creates production build in `dist/`
- **Test**: `npm test` - Runs Jest tests

## Configuration
- `rsbuild.config.ts` - Build configuration
- `tsconfig.json` - TypeScript configuration
- Environment variables are defined in `source.define` in rsbuild config

## Recent Changes
- Configured for Replit environment (port 5000, host 0.0.0.0)
- Set up development workflow

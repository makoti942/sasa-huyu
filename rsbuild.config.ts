import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';
import { pluginBasicSsl } from '@rsbuild/plugin-basic-ssl';

const path = require('path');

export default defineConfig({
    plugins: [
        pluginSass({
            sassLoaderOptions: {
                sourceMap: true,
                sassOptions: {
                    // includePaths: [path.resolve(__dirname, 'src')],
                },
                // additionalData: `@use "${path.resolve(__dirname, 'src/components/shared/styles')}" as *;`,
            },
            exclude: /node_modules/,
        }),
        pluginReact(),
        // pluginBasicSsl(), // Disabled for easier local access
    ],
    source: {
        entry: {
            index: './src/main.tsx',
        },
        include: [/node_modules\/@deriv-com\/translations/],
        define: {
            'process.env': {
                NODE_ENV: JSON.stringify(process.env.NODE_ENV || 'development'),
                TRANSLATIONS_CDN_URL: JSON.stringify(process.env.TRANSLATIONS_CDN_URL),
                R2_PROJECT_NAME: JSON.stringify(process.env.R2_PROJECT_NAME),
                CROWDIN_BRANCH_NAME: JSON.stringify(process.env.CROWDIN_BRANCH_NAME),
                TRACKJS_TOKEN: JSON.stringify(process.env.TRACKJS_TOKEN),
                APP_ENV: JSON.stringify(process.env.APP_ENV),
                REF_NAME: JSON.stringify(process.env.REF_NAME),
                REMOTE_CONFIG_URL: JSON.stringify(process.env.REMOTE_CONFIG_URL),
                GD_CLIENT_ID: JSON.stringify(process.env.GD_CLIENT_ID),
                GD_APP_ID: JSON.stringify(process.env.GD_APP_ID),
                GD_API_KEY: JSON.stringify(process.env.GD_API_KEY),
                DATADOG_SESSION_REPLAY_SAMPLE_RATE: JSON.stringify(process.env.DATADOG_SESSION_REPLAY_SAMPLE_RATE),
                DATADOG_SESSION_SAMPLE_RATE: JSON.stringify(process.env.DATADOG_SESSION_SAMPLE_RATE),
                DATADOG_APPLICATION_ID: JSON.stringify(process.env.DATADOG_APPLICATION_ID),
                DATADOG_CLIENT_TOKEN: JSON.stringify(process.env.DATADOG_CLIENT_TOKEN),
                RUDDERSTACK_KEY: JSON.stringify(process.env.RUDDERSTACK_KEY),
                GROWTHBOOK_CLIENT_KEY: JSON.stringify(process.env.GROWTHBOOK_CLIENT_KEY),
                GROWTHBOOK_DECRYPTION_KEY: JSON.stringify(process.env.GROWTHBOOK_DECRYPTION_KEY),
            },
        },
        alias: {
            react: path.resolve('./node_modules/react'),
            'react-dom': path.resolve('./node_modules/react-dom'),
            // Temporary shim for malformed @deriv-com/ui import path "Submenu /index.js"
            './components/AppLayout/Submenu /index.js': path.resolve(
                __dirname,
                './src/components/shims/ui-submenu/index.js'
            ),
            '../Submenu /index.js': path.resolve(__dirname, './src/components/shims/ui-submenu/index.js'),
            // Route all @deriv/quill-icons paths to the top-level package (now complete with all categories)
            '@deriv/quill-icons': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/index.js'
            ),
            '@deriv/quill-icons/Legacy': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Legacy'
            ),
            '@deriv/quill-icons/LabelPaired': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/LabelPaired'
            ),
            '@deriv/quill-icons/Standalone': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Standalone'
            ),
            '@deriv/quill-icons/Flags': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Flags'
            ),
            '@deriv/quill-icons/Illustration': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Illustration'
            ),
            '@deriv/quill-icons/Logo': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Logo'
            ),
            '@deriv/quill-icons/Currencies': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Currencies'
            ),
            '@deriv/quill-icons/Accounts': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Accounts'
            ),
            '@deriv/quill-icons/Markets': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Markets'
            ),
            '@deriv/quill-icons/Social': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Social'
            ),
            '@deriv/quill-icons/PaymentMethods': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/PaymentMethods'
            ),
            '@deriv/quill-icons/Illustrative': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/Illustrative'
            ),
            '@deriv/quill-icons/TradeTypes': path.resolve(
                __dirname,
                'node_modules/@deriv/quill-icons/dist/esm/react/TradeTypes'
            ),
            // Ensure rudderstack analytics-js resolves from top-level node_modules
            '@rudderstack/analytics-js': path.resolve(
                __dirname,
                'node_modules/@rudderstack/analytics-js/dist/npm/modern/cjs/index.cjs'
            ),
            // Stub object.fromentries to avoid pulling in broken es-abstract/2024 dependencies
            'object.fromentries': path.resolve(
                __dirname,
                'src/components/shims/object-fromentries/index.js'
            ),
            '@/external': path.resolve(__dirname, './src/external'),
            '@/components': path.resolve(__dirname, './src/components'),
            '@/hooks': path.resolve(__dirname, './src/hooks'),
            '@/utils': path.resolve(__dirname, './src/utils'),
            '@/constants': path.resolve(__dirname, './src/constants'),
            '@/stores': path.resolve(__dirname, './src/stores'),
            '@/types': path.resolve(__dirname, './src/types'),
            '@/pages': path.resolve(__dirname, './src/pages'),
            '@/app': path.resolve(__dirname, './src/app'),
            '@/auth': path.resolve(__dirname, './src/auth'),
        },
    },
    output: {
        copy: [
            {
                from: 'node_modules/@deriv/deriv-charts/dist/*',
                to: 'js/smartcharts/[name][ext]',
                globOptions: {
                    ignore: ['**/*.LICENSE.txt'],
                },
            },
            { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/*', to: 'assets/[name][ext]' },
            { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/fonts/*', to: 'assets/fonts/[name][ext]' },
            { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/shaders/*', to: 'assets/shaders/[name][ext]' },
            { from: path.join(__dirname, 'public') },
        ],
    },
    html: {
        template: './index.html',
    },
    server: {
        port: 5000,
        host: '0.0.0.0',
        compress: true,
        historyApiFallback: true,
        headers: {
            'Access-Control-Allow-Origin': '*',
        },
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                secure: false,
            },
        },
    },
    dev: {
        hmr: true,
    },
    tools: {
        rspack: {
            plugins: [],
            resolve: {},
            module: {
                rules: [
                    {
                        test: /\.xml$/,
                        exclude: /node_modules/,
                        use: 'raw-loader',
                    },
                ],
            },
        },
    },
});

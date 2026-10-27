import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/qa',testMatch:'holy-sheet-live.spec.ts',workers:1,retries:0,timeout:600000,expect:{timeout:15000},reporter:'list',use:{trace:'off',screenshot:'off',launchOptions:{executablePath:process.env.PW_CHROMIUM||'/usr/bin/google-chrome'}},outputDir:'test-results/holy3062-browser'});

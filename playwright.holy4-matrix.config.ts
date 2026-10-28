import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/qa',testMatch:'holy4-matrix.spec.ts',workers:1,retries:0,timeout:1200000,expect:{timeout:15000},reporter:'list',use:{trace:'off',screenshot:'off',launchOptions:{executablePath:process.env.PW_CHROMIUM||'/usr/bin/google-chrome'}},outputDir:'test-results/holy4-matrix-browser'});

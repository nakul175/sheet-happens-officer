-- PostgreSQL requires this enum addition committed before the next migration uses DELIVERY.
ALTER TYPE "StageCategory" ADD VALUE 'DELIVERY';

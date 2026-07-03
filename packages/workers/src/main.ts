// @hivly/workers — Indexer + Sync consumers process (AD-1: standalone Node process).
// XREADGROUP consumers, embeddings and pgvector upserts land in Epics 3/6; scaffold stub.
import { PACKAGE_NAME } from '@hivly/shared';

console.log(`[workers] starting — depends on shared kernel ${PACKAGE_NAME}`);

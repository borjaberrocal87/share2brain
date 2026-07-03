// @hivly/backend — Express API + RAG agent process (AD-1: standalone Node process).
// loadConfig(), routes, SSE chat and the LangGraph agent land in later epics; scaffold stub.
import { PACKAGE_NAME } from '@hivly/shared';

console.log(`[backend] starting — depends on shared kernel ${PACKAGE_NAME}`);

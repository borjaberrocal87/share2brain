// Domain port: turn a natural-language query into an embedding vector. Pure — no
// LangChain, no provider SDK. The adapter in infrastructure/ wraps the provider
// factory and keeps that import behind this contract, so the application service
// depends only on the interface (AD-2 spirit).
export interface QueryEmbedder {
  /**
   * Embed a search query. The returned vector's width is asserted against
   * `config.embeddings.dimensions` by the adapter (the corrupt all-zero-vector bug
   * from Story 3.0 must fail loudly, not produce a garbage search).
   */
  embedQuery(text: string): Promise<number[]>;
}

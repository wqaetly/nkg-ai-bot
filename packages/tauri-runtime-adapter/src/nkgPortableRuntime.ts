/**
 * Compatibility export. Portable Runtime composition now belongs to
 * nkg-ai-flow itself; this host adapter only preserves the application API.
 */
export {
  createPortableHttpRuntime as createNkgPortableRuntime,
  type CreatePortableHttpRuntimeOptions as CreateNkgPortableRuntimeOptions,
  type PortableHttpRuntime as NkgPortableRuntime,
} from "@ai-native-flow/transport-http";

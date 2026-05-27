// Roslyn'in `api-contract` subkomut çıktısının TS tarafı tipi.
// Şekil Roslyn Endpoint record'ı ile uyumlu (camelCase).

export type Endpoint = {
  method: string
  route: string
  source: "minimal-api" | "mvc-controller" | "extension-method"
  file: string
  line: number
  auth: string | null
  handlerName: string | null
  requestType: string | null
  responseType: string | null
  hasCancellationToken: boolean
}

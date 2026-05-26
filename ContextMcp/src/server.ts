import express from "express"
import path from "path"

import { buildContext, getContext } from "./core/indexer"
import { buildSmartContext } from "./context/smartContext"
import { buildFinalContext } from "./optimize/smartContextFinal"
import { buildFunctionContext } from "./function/functionContext"
import { buildDataFlowChain } from "./dataflow/dataFlowChain"
import { findBug } from "./debug/smartBugFinder"
import { reviewCode } from "./review/reviewEngine"

import { loadPlugins } from "./plugins"
import { runOnQuery, registerAllTools } from "./plugins/pluginManager"

const app = express()
app.use(express.json())

// UI route
app.use("/ui", express.static(path.join(process.cwd(), "ui")))

// root redirect
app.get("/", (_req, res) => {
  res.redirect("/ui")
})

loadPlugins()

app.post("/context/build", (_req, res) => {
  buildContext()
  res.json({ ok: true })
})

app.post("/context/smart", (req, res) => {
  res.json({ result: buildSmartContext(req.body.query) })
})

app.post("/context/final", (req, res) => {
  res.json({ result: buildFinalContext(req.body.query) })
})

app.post("/context/functions", (req, res) => {
  res.json({ result: buildFunctionContext(req.body.query) })
})

app.post("/context/deep", (req, res) => {
  res.json({ result: buildDataFlowChain(req.body.entry) })
})

app.post("/context/debug", (req, res) => {
  res.json({ result: findBug(req.body.query) })
})

app.post("/context/review", (req, res) => {
  const { query, categories, minSeverity } = req.body ?? {}
  res.json({ result: reviewCode(query, { categories, minSeverity }) })
})

app.post("/context/plugins", (req, res) => {
  res.json({ result: runOnQuery(req.body.query, getContext()) })
})

registerAllTools(app)

app.listen(4000, () => {
  console.log("http://localhost:4000")
})
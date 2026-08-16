// Pure view helpers shared by the browser app and the Node test suite.
//
// Like data.js, this file is a plain browser script loaded through a <script>
// tag and evaluated in a vm sandbox by Node. Keep it free of DOM access and of
// module syntax (no require/module.exports/import/export) so both runtimes can
// load it.
const STUDIOFLOW_VIEW = {
  // Every value interpolated into an innerHTML template must pass through this,
  // including values placed inside attributes. Run data arrives from the API and
  // is not trusted markup.
  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  },

  // Flattens a server-shaped run into the client's flat state. Call this exactly
  // once per API response: normalizing an already-normalized run throws, which
  // silently drops the app into its offline fallback path.
  normalizeApiRun(apiRun, demo) {
    return {
      tasks: apiRun.tasks.map((task) => ({
        id: task.id.replace(/^task_/, ""),
        title: task.title,
        agent: demo.tasks.find((demoTask) => demoTask.id === task.id)?.agent || task.agent,
        state: task.state,
      })),
      artifacts: apiRun.artifacts.map((artifact) => ({
        type: artifact.type,
        title: artifact.title,
        body: artifact.summary,
        // The generated content itself, so a rerun is visibly different rather
        // than only carrying a higher version number.
        content: artifact.content_markdown || null,
        version: `v${artifact.version}`,
      })),
      reviews: apiRun.review_items,
      // The server appends events oldest-first; the audit panel and the offline
      // path both read newest-first, so the freshest event stays at the top.
      audit: apiRun.audit_events
        .map((event) => ({
          time: new Date(event.created_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          message: event.message,
        }))
        .reverse(),
      packetReady: Boolean(apiRun.packet_ready || apiRun.project.status === "approved"),
      packetMarkdown: apiRun.packet_markdown || null,
      // The brief chips must come from the run, not from the bundled scenario —
      // otherwise the Intake Agent's output never reaches the screen.
      projectTitle: apiRun.project?.title || null,
      status: apiRun.project?.status || null,
      metrics: apiRun.metrics || null,
      briefFields: apiRun.brief?.structured_fields || null,
      clarifyingQuestions: apiRun.brief?.clarifying_questions || [],
      parsedBy: apiRun.brief?.parsed_by || null,
      traceId: apiRun.trace_id,
    };
  },
};

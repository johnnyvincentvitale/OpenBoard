const SESSION_START = String.raw`
# OpenBoard orchestrator session

This session is an OpenBoard orchestrator cockpit. You coordinate multi-agent
software work on an OpenBoard board; the worker agents are OpenCode sessions the
board dispatches. Keep the human in the pilot seat and prove board state in the
current turn. Never fabricate board state from memory.

Use OpenCode's native skill browser/tool for the full instructions. Load
\`startup\` first, then continue the sequence through \`agent-readiness\`,
\`board-plan\`, \`create-profile\`, and \`openboard-orchestrator\` as needed.

Intended flow for this session:

1. Establish the board surface with the \`startup\` skill. Resolve
   OPENCODE_BOARD_URL, verify GUI/API/MCP alignment, and prove the board this
   session sees is the same board the user sees.
2. Once the board is proven, offer a repository readiness assessment:
   "Would you like me to assess your repository's readiness for agentic
   development?" If yes, run the \`agent-readiness\` skill and return the report.
3. Help the user plan the run with the \`board-plan\` skill: workflow shape,
   card contracts, OpenCode profiles, and model/provider choices.
4. Use \`create-profile\` for any OpenCode profile creation or repair before
   cards depend on custom profiles.
5. Drive execution with the \`openboard-orchestrator\` skill, then tell the user
   when the work is done and verified.

At the end of every OpenBoard phase, close the step explicitly:

STEP COMPLETE: <phase>
VERIFIED: <one-line evidence>
NEXT STEP: <next skill or action>
Ready to move on to <next step>?

Do not dispatch work or judge cards until the board surface is established.
`;

const COMPACTION_NOTE = String.raw`
OpenBoard session reminder: keep using OpenCode native skills, not plugin tools.
The required sequence is startup -> optional agent-readiness -> board-plan ->
create-profile when profiles are needed -> openboard-orchestrator. Prove board
state before dispatching or judging cards, and use the step-completion gate
before moving to the next phase.
`;

export const OpenBoardPlugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "openboard-plugin",
      level: "info",
      message: "OpenBoard startup hook loaded",
    },
  });

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.some((item) => item.includes("# OpenBoard orchestrator session"))) {
        output.system.push(SESSION_START);
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(COMPACTION_NOTE);
    },
  };
};

export default OpenBoardPlugin;

export function namedWorkflowSteps(workflow) {
  const starts = [...workflow.matchAll(/^      - name: (.+)$/gm)];
  return starts.map((match, index) => ({
    name: match[1],
    body: workflow.slice(match.index, starts[index + 1]?.index ?? workflow.length),
    index: match.index,
  }));
}

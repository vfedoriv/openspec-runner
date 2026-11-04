// No-model permission diagnostics advertised by the simulated Codex executable.
// Native sandbox acceptance separately verifies the installed CLI's contract.
export const codexDiagnostics = `
if(process.argv[2]==='debug' && process.argv[3]==='prompt-input') {
  const table=process.argv.find(arg=>arg.startsWith('permissions.openspec_runner_'))||'';
  const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const protectedEntries=['.git','.codex','.agents','.aws'].map(name=>'<entry access="read"><path>'+xml(require('path').join(process.cwd(),name))+'</path></entry>').join('');
  const entries=protectedEntries+[...table.matchAll(/("(?:[^"\\\\]|\\\\.)*")="(read|write)"/g)].map(m=>'<entry access="'+m[2]+'"><path>'+xml(JSON.parse(m[1]))+'</path></entry>').join('');
  console.log(JSON.stringify([{role:'user',type:'message',content:[{type:'input_text',text:'<environment_context><cwd>'+xml(process.cwd())+'</cwd><filesystem><permission_profile type="managed"><file_system type="restricted">'+entries+'</file_system></permission_profile></filesystem></environment_context>'}]}]));
  process.exit(0);
}
`;

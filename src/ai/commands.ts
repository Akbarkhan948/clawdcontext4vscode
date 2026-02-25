/**
 * AI-powered commands for ClawdContext.
 *
 * All commands gracefully degrade when AI is not configured:
 * they show a message prompting the user to set up their provider.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isAiEnabled, aiComplete, testAiConnection, getAiConfig } from './provider';
import { state } from '../commands/analyzeWorkspace';

// ─── Guards ─────────────────────────────────────────────────────────

function requireAi(): boolean {
  if (!isAiEnabled()) {
    const config = getAiConfig();
    if (config.provider === 'none') {
      vscode.window.showInformationMessage(
        'AI is not configured. Set "clawdcontext.ai.provider" in settings to enable AI features.',
        'Open Settings',
      ).then(choice => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'clawdcontext.ai',
          );
        }
      });
    } else {
      vscode.window.showWarningMessage(
        `API key required for ${config.provider}. Set "clawdcontext.ai.apiKey" in settings.`,
        'Open Settings',
      ).then(choice => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'clawdcontext.ai.apiKey',
          );
        }
      });
    }
    return false;
  }
  return true;
}

function requireWorkspace(): boolean {
  if (!state.budget) {
    vscode.window.showWarningMessage(
      'Run "ClawdContext: Analyze Workspace" first.',
    );
    return false;
  }
  return true;
}

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are ClawdContext AI, an expert assistant for Markdown OS / agent kernel systems.

You help users optimise their AI coding agent configuration files (CLAUDE.md, AGENTS.md, SKILL.md, lessons.md, todo.md).

Key concepts you know deeply:
- **CER (Context Efficiency Ratio)**: useful tokens / total tokens. Target > 0.6.
- **Markdown OS layers**: Kernel (CLAUDE.md), Skills (SKILL.md), Tasks (todo.md), Learning (lessons.md), Hooks (.clawdcontext/hooks/).
- **Lost-in-the-Middle (LoitM)**: Critical instructions in the middle of long documents get lower attention. Put them at start or end.
- **Shannon SNR**: More instructions ≠ more performance. Noise drowns signal.
- **Lazy loading**: Skills should be loaded on-demand, not always. Keeps CER high.
- **Security patterns**: SKILL.md files can contain shell commands, env vars, URLs that are legitimate docs but could be injection vectors.

Be concise, actionable, and specific. Use bullet points. Reference CER numbers when relevant.`;

// ─── Commands ───────────────────────────────────────────────────────

/**
 * Test the AI connection and show the result.
 */
export async function aiTestConnection(): Promise<void> {
  if (!requireAi()) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing AI connection...' },
    async () => {
      try {
        const result = await testAiConnection();
        vscode.window.showInformationMessage(`✅ ${result}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`❌ AI connection failed: ${msg}`);
      }
    },
  );
}

/**
 * AI-powered review of the agent kernel config.
 * Sends CER metrics + CLAUDE.md content for optimisation suggestions.
 */
export async function aiReviewConfig(): Promise<void> {
  if (!requireAi() || !requireWorkspace()) { return; }

  const budget = state.budget!;

  // Read CLAUDE.md content if available
  let claudeMd = '';
  const kernelFiles = budget.filesByLayer.get('kernel') || [];
  const claudeFile = kernelFiles.find(f =>
    f.relativePath.toLowerCase().includes('claude.md'),
  );
  if (claudeFile) {
    claudeMd = claudeFile.content.substring(0, 8000); // Limit to avoid huge payloads
  }

  const cerPct = (budget.cer * 100).toFixed(1);
  const alwaysK = (budget.alwaysLoadedTokens / 1000).toFixed(1);
  const onDemandK = (budget.onDemandTokens / 1000).toFixed(1);
  const headroomK = (budget.reasoningHeadroom / 1000).toFixed(1);

  // Build layer summary
  const layerSummary = (['hook', 'kernel', 'skill', 'task', 'learning', 'subagent'] as const)
    .map(key => {
      const files = budget.filesByLayer.get(key) || [];
      const tokens = files.reduce((s, f) => s + f.tokens, 0);
      return files.length > 0 ? `  - ${key}: ${files.length} files, ${(tokens / 1000).toFixed(1)}K tokens` : '';
    })
    .filter(Boolean)
    .join('\n');

  // Security summary
  const secFindings = state.lintResult?.securityReports.reduce(
    (sum, r) => sum + r.findings.filter(f => !f.suppressed).length, 0,
  ) ?? 0;

  const prompt = `Review this AI agent's Markdown OS configuration and suggest improvements.

## Current Metrics
- CER: ${cerPct}% (${budget.cerStatus})
- Always-loaded: ${alwaysK}K tokens
- On-demand: ${onDemandK}K tokens
- Reasoning headroom: ${headroomK}K tokens
- Total budget: ${(budget.totalBudget / 1000).toFixed(0)}K tokens
- Files: ${budget.allFiles.length}
- Active security findings: ${secFindings}

## Layer Distribution
${layerSummary}

## CLAUDE.md Content (first 8000 chars)
\`\`\`markdown
${claudeMd || '(No CLAUDE.md found)'}
\`\`\`

## Please Provide
1. **CER assessment**: Is the ratio healthy? What's consuming too many tokens?
2. **Content audit**: Are there sections in CLAUDE.md that should be extracted to SKILL.md (lazy-loaded)?
3. **Positional risks**: Any critical instructions buried in the middle?
4. **Quick wins**: Top 3 actionable changes to improve context efficiency.`;

  await streamToDocument('ClawdContext AI: Config Review', prompt);
}

/**
 * AI-powered explanation of a specific diagnostic.
 * Uses the active editor's diagnostics for context.
 */
export async function aiExplainDiagnostic(): Promise<void> {
  if (!requireAi()) { return; }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a file with diagnostics first.');
    return;
  }

  // Get diagnostics for the current file
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
    .filter(d => d.source === 'ClawdContext');

  if (diagnostics.length === 0) {
    vscode.window.showInformationMessage('No ClawdContext diagnostics in this file.');
    return;
  }

  // If multiple, let user pick
  let diagnostic: vscode.Diagnostic;
  if (diagnostics.length === 1) {
    diagnostic = diagnostics[0];
  } else {
    const items = diagnostics.map((d, i) => ({
      label: `Line ${d.range.start.line + 1}: ${d.message.substring(0, 80)}`,
      index: i,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Which diagnostic?',
      placeHolder: 'Select a diagnostic to explain',
    });
    if (!pick) { return; }
    diagnostic = diagnostics[pick.index];
  }

  // Get surrounding context
  const startLine = Math.max(0, diagnostic.range.start.line - 5);
  const endLine = Math.min(editor.document.lineCount - 1, diagnostic.range.end.line + 5);
  const context = editor.document.getText(
    new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length),
  );

  const prompt = `Explain this ClawdContext diagnostic and suggest how to fix it.

## Diagnostic
- **Message**: ${diagnostic.message}
- **Severity**: ${vscode.DiagnosticSeverity[diagnostic.severity]}
- **Location**: ${editor.document.fileName}:${diagnostic.range.start.line + 1}

## Surrounding Context (lines ${startLine + 1}-${endLine + 1})
\`\`\`markdown
${context}
\`\`\`

## Please Provide
1. **Why** this diagnostic fired — what rule or pattern triggered it
2. **Risk** — what could go wrong if ignored
3. **Fix** — concrete rewrite suggestion with the corrected markdown`;

  await streamToDocument('ClawdContext AI: Diagnostic Explanation', prompt);
}

/**
 * AI-powered suggestion for what to refactor from the kernel.
 * Identifies content that should move from always-loaded to on-demand.
 */
export async function aiSuggestRefactor(): Promise<void> {
  if (!requireAi() || !requireWorkspace()) { return; }

  const budget = state.budget!;

  // Gather always-loaded file info
  const alwaysFiles = budget.allFiles
    .filter(f => f.alwaysLoaded)
    .map(f => ({
      path: f.relativePath,
      tokens: f.tokens,
      headings: extractHeadings(f.content),
    }));

  if (alwaysFiles.length === 0) {
    vscode.window.showInformationMessage('No always-loaded files found.');
    return;
  }

  const fileList = alwaysFiles.map(f =>
    `### ${f.path} (${(f.tokens / 1000).toFixed(1)}K tokens)\nHeadings: ${f.headings.join(' → ') || '(none)'}`,
  ).join('\n\n');

  const prompt = `Analyze these always-loaded Markdown OS files and suggest what to extract into on-demand SKILL.md files.

## Current CER: ${(budget.cer * 100).toFixed(1)}% (${budget.cerStatus})
Always-loaded: ${(budget.alwaysLoadedTokens / 1000).toFixed(1)}K tokens
Budget: ${(budget.totalBudget / 1000).toFixed(0)}K tokens

## Always-Loaded Files
${fileList}

## Refactoring Criteria
- Sections > 500 tokens that are only needed for specific tasks → extract to SKILL.md
- Deployment/build instructions → move to a deploy skill
- Language-specific details → move to a language skill
- Historical context/lessons → move to lessons.md
- Keep: Core identity, critical rules, common commands (< 200 tokens)

## Please Provide
1. **Extraction candidates**: Which sections should move, where to, estimated token savings
2. **Priority order**: Which extraction gives the best CER improvement
3. **Risk assessment**: Any sections that MUST stay always-loaded (critical rules)
4. **Projected CER**: Expected CER after suggested refactoring`;

  await streamToDocument('ClawdContext AI: Refactor Suggestions', prompt);
}

/**
 * AI-powered security analysis of the currently open SKILL.md.
 * Goes beyond regex patterns to understand intent.
 */
export async function aiSecurityReview(): Promise<void> {
  if (!requireAi()) { return; }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a SKILL.md file first.');
    return;
  }

  const content = editor.document.getText();
  const fileName = path.basename(editor.document.fileName);

  // Check if it's a skill-like file
  if (!fileName.includes('SKILL') && !fileName.includes('skill') && !editor.document.fileName.includes('/skills/')) {
    const proceed = await vscode.window.showWarningMessage(
      'This doesn\'t appear to be a SKILL.md file. Analyze anyway?',
      'Yes', 'No',
    );
    if (proceed !== 'Yes') { return; }
  }

  // Truncate very large files
  const truncated = content.substring(0, 12000);

  const prompt = `Perform a security review of this SKILL.md file for an AI coding agent.

## File: ${editor.document.fileName}
\`\`\`markdown
${truncated}
\`\`\`
${content.length > 12000 ? `\n(Truncated from ${content.length} to 12000 chars)\n` : ''}

## Security Analysis Requested
Evaluate for these threat categories:
1. **Prompt injection**: Instructions that could override the agent's system prompt
2. **Credential exposure**: Secrets, API keys, tokens, passwords in plain text
3. **Data exfiltration**: URLs or commands that could leak data to external services
4. **Privilege escalation**: Commands that grant elevated permissions
5. **Persistence**: Instructions that modify system files or create backdoors
6. **Social engineering**: Instruction patterns that manipulate agent behavior subtly

## For Each Finding, Provide
- Severity (Critical / High / Medium / Low / Info)
- Line reference or quote
- Why it's a risk (or why it's a false positive if it's a documentation example)
- Recommended mitigation

## Also Provide
- Overall trust assessment (1-10 scale)
- Whether this file is safe to include in an agent's context without human review`;

  await streamToDocument('ClawdContext AI: Security Review', prompt);
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract markdown headings from content. */
function extractHeadings(content: string): string[] {
  return content
    .split('\n')
    .filter(line => /^#{1,4}\s/.test(line))
    .map(line => line.replace(/^#+\s*/, '').trim())
    .slice(0, 20);
}

/**
 * Send a prompt to the AI and display the result in a new untitled document.
 * Shows progress notification while waiting.
 */
async function streamToDocument(title: string, userPrompt: string): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${title} — thinking...`,
      cancellable: false,
    },
    async () => {
      try {
        const result = await aiComplete({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          maxTokens: 3000,
        });

        // Create a new untitled document with the result
        const doc = await vscode.workspace.openTextDocument({
          content: `# ${title}\n\n${result.content}\n\n---\n_Model: ${result.model}${result.tokensUsed ? ` · ${result.tokensUsed} tokens` : ''}_\n`,
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`AI request failed: ${msg}`);
      }
    },
  );
}

Successfully added Workflow Generator Patterns to `agent-patterns/effect-schema.md`. The new section provides n8n-style workflow orchestration capabilities with:

**Key additions:**

- Workflow Definition Schema (`WorkflowNode`, `WorkflowConnection`, `WorkflowDefinition`) for describing pipelines
- Plugin Registry with validation that loads and validates workflow JSON files
- Dynamic Task Pipeline with dependency resolution, parallel execution, and timeout/retry handling
- State management via `WorkflowExecution` schema with checkpointing and node status tracking
- Comprehensive error recovery with rollback mechanisms using typed `WorkflowError`
- Integration layer connecting workflow nodes to existing Victral tools (tikr_search, etc.)

**Usage patterns:**

- Define workflows as JSON with nodes, connections, and triggers
- Load and validate plugins using the registry schema
- Execute pipelines with topological sorting and parallel processing
- Handle failures with automatic rollback of dependent nodes
- Bind workflow nodes to existing tool implementations

**Quick Reference** table maps patterns to use cases with key elements. All examples reference @repos/effect for design patterns and use Effect for typed error handling and state management consistent with existing Victral tools.

The workflow generator enables building configurable, validated orchestrators that can be composed dynamically, similar to n8n but with Effect's typed safety and error handling guarantees.

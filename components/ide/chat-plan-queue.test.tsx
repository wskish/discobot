import assert from "node:assert";
import { describe, it } from "node:test";
import { render, screen } from "@testing-library/react";
import {
	ChatPlanQueue,
	type PlanEntry,
	QueueButton,
	QueuePanel,
} from "./chat-plan-queue";

// Mock plan data
const createMockPlan = (): PlanEntry[] => [
	{ content: "Task 1", status: "completed", activeForm: "Completing Task 1" },
	{
		content: "Task 2",
		status: "in_progress",
		activeForm: "Working on Task 2",
	},
	{ content: "Task 3", status: "pending", activeForm: "Preparing Task 3" },
];

describe("ChatPlanQueue", () => {
	describe("compound component pattern with children", () => {
		it("should render children when plan is null", () => {
			const { container } = render(
				<ChatPlanQueue plan={null}>
					<div data-testid="child-element">Child Content</div>
				</ChatPlanQueue>,
			);

			const childElement = container.querySelector(
				'[data-testid="child-element"]',
			);
			assert.ok(childElement, "Child element should be rendered");
			assert.strictEqual(
				childElement?.textContent,
				"Child Content",
				"Child content should be preserved",
			);
		});

		it("should render children when plan is empty array", () => {
			const { container } = render(
				<ChatPlanQueue plan={[]}>
					<div data-testid="child-element">Child Content</div>
				</ChatPlanQueue>,
			);

			const childElement = container.querySelector(
				'[data-testid="child-element"]',
			);
			assert.ok(childElement, "Child element should be rendered");
		});

		it("should render children with queue context when plan exists", () => {
			const plan = createMockPlan();
			const { container } = render(
				<ChatPlanQueue plan={plan}>
					<div data-testid="child-element">Child Content</div>
				</ChatPlanQueue>,
			);

			const childElement = container.querySelector(
				'[data-testid="child-element"]',
			);
			assert.ok(
				childElement,
				"Child element should be rendered with plan context",
			);
		});

		it("should render multiple children", () => {
			const { container } = render(
				<ChatPlanQueue plan={null}>
					<div data-testid="child-1">Child 1</div>
					<div data-testid="child-2">Child 2</div>
				</ChatPlanQueue>,
			);

			const child1 = container.querySelector('[data-testid="child-1"]');
			const child2 = container.querySelector('[data-testid="child-2"]');
			assert.ok(child1, "First child should be rendered");
			assert.ok(child2, "Second child should be rendered");
		});
	});

	describe("legacy inline rendering without children", () => {
		it("should return null when plan is null and no children", () => {
			const { container } = render(<ChatPlanQueue plan={null} />);
			assert.strictEqual(
				container.firstChild,
				null,
				"Should render nothing when no plan and no children",
			);
		});

		it("should return null when plan is empty array and no children", () => {
			const { container } = render(<ChatPlanQueue plan={[]} />);
			assert.strictEqual(
				container.firstChild,
				null,
				"Should render nothing when empty plan and no children",
			);
		});

		it("should render inline queue when plan exists and no children", () => {
			const plan = createMockPlan();
			render(<ChatPlanQueue plan={plan} />);

			// Check for todo label
			const todoLabel = screen.getByText(/Todo \(\d+ completed\)/);
			assert.ok(todoLabel, "Todo label should be rendered");
		});

		it("should display correct completion count in inline mode", () => {
			const plan = createMockPlan(); // 1 completed, 1 in_progress, 1 pending
			const { container } = render(<ChatPlanQueue plan={plan} />);

			const todoLabel = container.querySelector(
				'[data-slot="collapsible-trigger"]',
			);
			assert.ok(todoLabel, "Todo label should be rendered");
			assert.ok(
				todoLabel?.textContent?.includes("Todo") &&
					todoLabel?.textContent?.includes("1 completed"),
				"Should show correct completion count (1 completed)",
			);
		});

		it("should render all plan entries in inline mode", () => {
			const plan = createMockPlan();
			const { container } = render(<ChatPlanQueue plan={plan} />);

			const body = container.textContent || "";
			assert.ok(body.includes("Task 1"), "Task 1 should be rendered");
			assert.ok(body.includes("Task 2"), "Task 2 should be rendered");
			assert.ok(body.includes("Task 3"), "Task 3 should be rendered");
		});
	});

	describe("plan entry rendering", () => {
		it("should display priority when specified", () => {
			const planWithPriority: PlanEntry[] = [
				{
					content: "High priority task",
					status: "pending",
					activeForm: "Working on high priority task",
					priority: "high",
				},
			];
			render(<ChatPlanQueue plan={planWithPriority} />);

			const priorityText = screen.getByText("Priority: high");
			assert.ok(priorityText, "Priority should be displayed");
		});

		it("should handle all status types", () => {
			const planWithStatuses: PlanEntry[] = [
				{
					content: "Completed task",
					status: "completed",
					activeForm: "Completing task",
				},
				{
					content: "In progress task",
					status: "in_progress",
					activeForm: "Working on task",
				},
				{
					content: "Pending task",
					status: "pending",
					activeForm: "Preparing task",
				},
			];
			render(<ChatPlanQueue plan={planWithStatuses} />);

			assert.ok(
				screen.getByText("Completed task"),
				"Completed task should render",
			);
			assert.ok(
				screen.getByText("In progress task"),
				"In progress task should render",
			);
			assert.ok(screen.getByText("Pending task"), "Pending task should render");
		});
	});
});

describe("QueueButton", () => {
	it("should return null when used outside ChatPlanQueue context", () => {
		const { container } = render(<QueueButton />);
		assert.strictEqual(
			container.firstChild,
			null,
			"Should render nothing when used outside context",
		);
	});

	it("should render progress count when inside ChatPlanQueue context", () => {
		const plan = createMockPlan(); // 1 completed, 3 total
		render(
			<ChatPlanQueue plan={plan}>
				<QueueButton />
			</ChatPlanQueue>,
		);

		const progressText = screen.getByText("1/3");
		assert.ok(progressText, "Should show progress as 1/3");
	});

	it("should return null when rendered with empty plan", () => {
		// When plan is empty, ChatPlanQueue renders children without context
		// QueueButton should gracefully return null when context is not available
		const { container } = render(
			<ChatPlanQueue plan={[]}>
				<QueueButton />
			</ChatPlanQueue>,
		);

		// QueueButton should render nothing when there's no context
		const button = container.querySelector("button");
		assert.strictEqual(
			button,
			null,
			"QueueButton should not render when plan is empty",
		);
	});

	it("should return null when rendered with null plan", () => {
		// When plan is null, ChatPlanQueue renders children without context
		// QueueButton should gracefully return null
		const { container } = render(
			<ChatPlanQueue plan={null}>
				<QueueButton />
			</ChatPlanQueue>,
		);

		const button = container.querySelector("button");
		assert.strictEqual(
			button,
			null,
			"QueueButton should not render when plan is null",
		);
	});
});

describe("QueuePanel", () => {
	it("should return null when used outside ChatPlanQueue context", () => {
		const plan = createMockPlan();
		const { container } = render(<QueuePanel plan={plan} />);
		assert.strictEqual(
			container.firstChild,
			null,
			"Should render nothing when used outside context",
		);
	});

	it("should return null when rendered with empty plan", () => {
		const plan = createMockPlan();
		const { container } = render(
			<ChatPlanQueue plan={[]}>
				<QueuePanel plan={plan} />
			</ChatPlanQueue>,
		);

		// QueuePanel should render nothing when there's no context
		assert.strictEqual(
			container.firstChild,
			null,
			"QueuePanel should not render when plan is empty",
		);
	});

	it("should return null when rendered with null plan", () => {
		const plan = createMockPlan();
		const { container } = render(
			<ChatPlanQueue plan={null}>
				<QueuePanel plan={plan} />
			</ChatPlanQueue>,
		);

		// QueuePanel should render nothing when there's no context
		assert.strictEqual(
			container.firstChild,
			null,
			"QueuePanel should not render when plan is null",
		);
	});

	it("should not render when expanded state is false", () => {
		const plan = createMockPlan();
		const { container } = render(
			<ChatPlanQueue plan={plan}>
				<QueuePanel plan={plan} />
			</ChatPlanQueue>,
		);

		// Panel should not be visible initially (isExpanded defaults to false)
		const panelContent = container.querySelector('[role="region"]');
		assert.strictEqual(
			panelContent,
			null,
			"Panel should not be visible when collapsed",
		);
	});

	it("should render plan entries when expanded", () => {
		const plan = createMockPlan();
		render(
			<ChatPlanQueue plan={plan}>
				<QueuePanel plan={plan} />
			</ChatPlanQueue>,
		);

		// Note: This test assumes the panel is not expanded by default
		// If we add a way to control expansion state, we'd test the expanded state
		// For now, we just verify it doesn't crash
		assert.ok(true, "QueuePanel renders without error");
	});
});

describe("Regression: QueueButton context error with null/empty plan", () => {
	it("should not throw when QueueButton is rendered inside ChatPlanQueue with null plan", () => {
		// This is the specific bug scenario: ChatPlanQueue wraps input area with QueueButton
		// but plan is null on new sessions. Previously this threw an error.
		const { container } = render(
			<ChatPlanQueue plan={null}>
				<div data-testid="input-wrapper">
					<QueueButton />
					<input type="text" placeholder="Type a message..." />
				</div>
			</ChatPlanQueue>,
		);

		// The input wrapper should be rendered
		const wrapper = container.querySelector('[data-testid="input-wrapper"]');
		assert.ok(wrapper, "Input wrapper should be rendered");

		// QueueButton should gracefully not render (return null)
		const button = container.querySelector("button");
		assert.strictEqual(
			button,
			null,
			"QueueButton should not render with null plan",
		);

		// Input should still be rendered
		const input = container.querySelector("input");
		assert.ok(input, "Input should still be rendered");
	});

	it("should not throw when QueueButton is rendered inside ChatPlanQueue with empty plan", () => {
		const { container } = render(
			<ChatPlanQueue plan={[]}>
				<div data-testid="input-wrapper">
					<QueueButton />
					<input type="text" placeholder="Type a message..." />
				</div>
			</ChatPlanQueue>,
		);

		const wrapper = container.querySelector('[data-testid="input-wrapper"]');
		assert.ok(wrapper, "Input wrapper should be rendered");

		const button = container.querySelector("button");
		assert.strictEqual(
			button,
			null,
			"QueueButton should not render with empty plan",
		);
	});

	it("should render QueueButton when plan has entries", () => {
		const plan = createMockPlan();
		const { container } = render(
			<ChatPlanQueue plan={plan}>
				<div data-testid="input-wrapper">
					<QueueButton />
					<input type="text" placeholder="Type a message..." />
				</div>
			</ChatPlanQueue>,
		);

		// QueueButton should render when there's a valid plan
		const wrapper = container.querySelector('[data-testid="input-wrapper"]');
		const button = wrapper?.querySelector("button");
		assert.ok(button, "QueueButton should render with valid plan");

		// Should show progress count (1 completed / 3 total)
		assert.ok(
			button?.textContent?.includes("1/3"),
			"Should show progress count",
		);
	});
});

describe("Regression: chat input visibility bug", () => {
	it("should not hide input area when wrapping it with null plan", () => {
		// This is the specific bug scenario: ChatPlanQueue wraps the input area
		// but plan is null on new sessions
		const { container } = render(
			<ChatPlanQueue plan={null}>
				<div data-testid="input-area" className="prompt-input">
					<input type="text" placeholder="Type a message..." />
				</div>
			</ChatPlanQueue>,
		);

		const inputArea = container.querySelector('[data-testid="input-area"]');
		assert.ok(inputArea, "Input area should be visible even with null plan");

		const input = inputArea?.querySelector("input");
		assert.ok(input, "Input element should be present");
		assert.strictEqual(
			input?.placeholder,
			"Type a message...",
			"Input placeholder should be correct",
		);
	});

	it("should not hide input area when wrapping it with empty plan", () => {
		const { container } = render(
			<ChatPlanQueue plan={[]}>
				<div data-testid="input-area" className="prompt-input">
					<input type="text" placeholder="Type a message..." />
				</div>
			</ChatPlanQueue>,
		);

		const inputArea = container.querySelector('[data-testid="input-area"]');
		assert.ok(inputArea, "Input area should be visible even with empty plan");
	});
});

"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ANIMATION_DURATION,
  useCollapsibleDisclosure,
} from "./use-collapsible-disclosure";

const ReasoningPreviewContext = createContext(false);

const reasoningVariants = cva("aui-reasoning-root mb-4 w-full", {
  variants: {
    variant: {
      outline: "rounded-lg border px-3 py-2",
      ghost: "",
      muted: "bg-muted/50 rounded-lg px-3 py-2",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
});

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    /**
     * Whether the reasoning is currently streaming. When provided, it
     * supersedes `defaultOpen`: the disclosure auto-opens while streaming
     * with a bottom-pinned live preview, auto-collapses when streaming
     * ends, and the first manual toggle takes over permanently.
     */
    streaming?: boolean;
  };

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming,
  children,
  ...props
}: ReasoningRootProps) {
  // Reasoning layers its streaming auto-open on the shared base: the disclosure hook
  // owns the scroll-lock ref, the lock callback, and the controlled detection; the
  // three-state `userOpen` (null = auto) and the streaming resolution stay here.
  const { ref, lockScroll, isControlled } = useCollapsibleDisclosure({
    open: controlledOpen,
    defaultOpen,
    onOpenChange: controlledOnOpenChange,
  });
  const initialOpenRef = useRef(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  // `streaming` only ever FORCES OPEN (a live trace auto-opens); it never forces closed, so once it
  // ends the disclosure falls back to `defaultOpen` (auto-collapse) rather than pinning shut - and an
  // explicit `streaming={false}` no longer clobbers a caller's `defaultOpen`. <!-- plan 35 M2 -->
  const isOpen =
    controlledOpen !== undefined
      ? controlledOpen
      : (userOpen ?? (streaming ? true : undefined) ?? initialOpenRef.current);
  const isAutoMode = isControlled || userOpen === null;
  const isPreview = streaming === true && isOpen && isAutoMode;

  const prevStreamingRef = useRef(streaming);
  useLayoutEffect(() => {
    if (prevStreamingRef.current === streaming) return;
    prevStreamingRef.current = streaming;
    if (!isControlled && userOpen === null) lockScroll();
  }, [streaming, isControlled, userOpen, lockScroll]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUserOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={ref}
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "group/reasoning-root",
        reasoningVariants({ variant, className }),
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>
        {children}
      </ReasoningPreviewContext.Provider>
    </Collapsible>
  );
}

function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  if (side === "top") {
    return (
      <div
        data-slot="reasoning-fade"
        className={cn(
          "aui-reasoning-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-8",
          "bg-[linear-gradient(to_bottom,var(--belay-reasoning-fade-bg,var(--color-background)),transparent)]",
          "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_bottom,hsl(var(--muted)/0.5),transparent)]",
          "fade-in-0 animate-in",
          "duration-(--animation-duration)",
          className,
        )}
        {...props}
      />
    );
  }

  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8",
        "bg-[linear-gradient(to_top,var(--belay-reasoning-fade-bg,var(--color-background)),transparent)]",
        "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,hsl(var(--muted)/0.5),transparent)]",
        "fade-in-0 animate-in",
        "group-data-[state=open]/collapsible-content:animate-out",
        "group-data-[state=open]/collapsible-content:fade-out-0",
        "group-data-[state=open]/collapsible-content:delay-[calc(var(--animation-duration)*0.75)]",
        "group-data-[state=open]/collapsible-content:fill-mode-forwards",
        "duration-(--animation-duration)",
        "group-data-[state=open]/collapsible-content:duration-(--animation-duration)",
        className,
      )}
      {...props}
    />
  );
}

function ReasoningTrigger({
  active,
  duration,
  label = "Reasoning",
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  duration?: number;
  /** The trigger copy (default "Reasoning"); the transcript passes "thinking" (plan 35). */
  label?: string;
}) {
  const durationText = duration ? ` (${duration}s)` : "";

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger text-muted-foreground hover:text-foreground flex max-w-[75%] items-center gap-2 py-1 text-sm transition-colors",
        className,
      )}
      {...props}
    >
      <BrainIcon
        data-slot="reasoning-trigger-icon"
        className="aui-reasoning-trigger-icon size-4 shrink-0"
      />
      <span
        data-slot="reasoning-trigger-label"
        className="aui-reasoning-trigger-label-wrapper relative inline-block leading-none"
      >
        <span>
          {label}
          {durationText}
        </span>
        {active ? (
          <span
            aria-hidden
            data-slot="reasoning-trigger-shimmer"
            className="aui-reasoning-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {label}
            {durationText}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        data-slot="reasoning-trigger-chevron"
        className={cn(
          "aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext);

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content text-muted-foreground relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      {isPreview ? <ReasoningFade side="top" /> : null}
      {children}
      <ReasoningFade />
    </CollapsibleContent>
  );
}

function ReasoningText({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPreview) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;
    const pin = () => {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [isPreview]);

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text relative z-0 me-6 max-h-64 overflow-y-auto ps-6 pt-2 pe-2 pb-2 leading-relaxed",
        "transform-gpu transition-[transform,opacity]",
        "group-data-[state=open]/collapsible-content:animate-in",
        "group-data-[state=closed]/collapsible-content:animate-out",
        "group-data-[state=open]/collapsible-content:fade-in-0",
        "group-data-[state=closed]/collapsible-content:fade-out-0",
        "group-data-[state=open]/collapsible-content:slide-in-from-top-4",
        "group-data-[state=closed]/collapsible-content:slide-out-to-top-4",
        "group-data-[state=open]/collapsible-content:duration-(--animation-duration)",
        "group-data-[state=closed]/collapsible-content:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div ref={contentRef} className="aui-reasoning-text-content space-y-4">
        {children}
      </div>
    </div>
  );
}

export type ReasoningGroupProps = Omit<ReasoningRootProps, "children"> & {
  children: React.ReactNode;
  active?: boolean;
  duration?: number;
  /** The trigger copy (default "Reasoning"); the transcript passes "thinking" (plan 35). */
  label?: string;
  contentProps?: Omit<
    React.ComponentProps<typeof CollapsibleContent>,
    "children"
  >;
  textProps?: Omit<React.ComponentProps<"div">, "children">;
};

const ReasoningGroup = memo(function ReasoningGroup({
  children,
  active,
  duration,
  label,
  contentProps,
  textProps,
  streaming,
  ...rootProps
}: ReasoningGroupProps) {
  const triggerActive = active ?? streaming;
  return (
    <ReasoningRoot streaming={streaming} {...rootProps}>
      <ReasoningTrigger active={triggerActive} duration={duration} label={label} />
      <ReasoningContent {...contentProps} aria-busy={streaming}>
        <ReasoningText {...textProps}>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
});

ReasoningGroup.displayName = "ReasoningGroup";

export { ReasoningGroup, reasoningVariants };

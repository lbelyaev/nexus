"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

export const ScrollArea = ({
  className,
  children,
  viewportRef,
  onViewportScroll,
}: {
  className?: string;
  children: React.ReactNode;
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
}) => {
  return (
    <ScrollAreaPrimitive.Root className={className}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        onScroll={onViewportScroll}
        className="h-full w-full rounded-[inherit]"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none border-l border-white/5 p-[1px]"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-white/20" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="bg-transparent" />
    </ScrollAreaPrimitive.Root>
  );
};

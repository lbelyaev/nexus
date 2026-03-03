"use client";

import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

export const Separator = ({ className }: { className?: string }) => (
  <SeparatorPrimitive.Root
    decorative
    orientation="horizontal"
    className={`h-px w-full bg-white/10 ${className ?? ""}`}
  />
);

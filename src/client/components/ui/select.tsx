import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import "./select.css";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className = "", children, ...props }, ref) => (
  <SelectPrimitive.Trigger ref={ref} className={`ui-select-trigger ${className}`.trim()} {...props}>
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown aria-hidden="true" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className = "", children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={`ui-select-content ${className}`.trim()}
      position={position}
      sideOffset={5}
      {...props}
    >
      <SelectPrimitive.ScrollUpButton className="ui-select-scroll-button">
        <ChevronUp aria-hidden="true" />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="ui-select-viewport">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="ui-select-scroll-button">
        <ChevronDown aria-hidden="true" />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className = "", children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={`ui-select-item ${className}`.trim()} {...props}>
    <span className="ui-select-item-indicator">
      <SelectPrimitive.ItemIndicator>
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

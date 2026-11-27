// A labelled group of setting cards within a settings page.
export default function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id ? `${id}-heading` : undefined} className="flex flex-col gap-4">
      <div id={id} className="scroll-mt-24">
        <h3 id={id ? `${id}-heading` : undefined} className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

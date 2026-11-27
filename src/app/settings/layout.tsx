import SettingsNav from "./SettingsNav";
import SettingsSearch from "./SettingsSearch";
import SettingHighlighter from "./SettingHighlighter";
import SettingsPageHeader from "./SettingsPageHeader";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Settings</h1>
      <SettingsSearch />
      <SettingHighlighter />
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-8">
        <aside className="md:w-48 md:shrink-0">
          <SettingsNav />
        </aside>
        <div className="min-w-0 flex-1">
          <SettingsPageHeader />
          {children}
        </div>
      </div>
    </div>
  );
}

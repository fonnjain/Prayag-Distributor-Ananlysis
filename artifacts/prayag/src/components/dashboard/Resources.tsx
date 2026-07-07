import { data } from "@/data/dataset";
import { KPICard } from "./shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Map, MapPin, Building2, Store } from "lucide-react";

export default function Resources() {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard title="States" value={data.coverage_totals.states} icon={<Map className="w-5 h-5" />} />
        <KPICard title="Districts" value={data.coverage_totals.districts} icon={<MapPin className="w-5 h-5" />} />
        <KPICard title="Cities" value={data.coverage_totals.cities} icon={<Building2 className="w-5 h-5" />} />
        <KPICard title="Retailers" value={data.coverage_totals.retailers.toLocaleString()} icon={<Store className="w-5 h-5" />} />
      </div>

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base font-semibold">Resource Coverage by Head</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">Head</th>
                  <th className="px-5 py-3 text-right font-medium">Distributors</th>
                  <th className="px-5 py-3 text-right font-medium">Dealers</th>
                  <th className="px-5 py-3 text-right font-medium">Total</th>
                  <th className="px-5 py-3 text-left font-medium">States Covered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.heads_resources.map((head, i) => (
                  <tr key={i} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3 font-medium whitespace-nowrap">{head.head}</td>
                    <td className="px-5 py-3 text-right">{head.distributors}</td>
                    <td className="px-5 py-3 text-right">{head.dealers}</td>
                    <td className="px-5 py-3 text-right font-semibold">{head.total}</td>
                    <td className="px-5 py-3 text-muted-foreground max-w-md truncate" title={head.states}>{head.states}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base font-semibold">State-wise Penetration</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto h-[400px]">
            <table className="w-full text-sm relative">
              <thead className="bg-muted/50 text-muted-foreground sticky top-0 backdrop-blur-md">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">State</th>
                  <th className="px-5 py-3 text-right font-medium">Districts</th>
                  <th className="px-5 py-3 text-right font-medium">Cities</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {[...data.coverage].sort((a, b) => b.cities - a.cities).map((cov, i) => (
                  <tr key={i} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3 font-medium">{cov.state}</td>
                    <td className="px-5 py-3 text-right">{cov.districts}</td>
                    <td className="px-5 py-3 text-right">{cov.cities}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

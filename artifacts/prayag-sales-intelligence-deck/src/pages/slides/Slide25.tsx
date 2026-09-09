import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide25() {
  return (
    <Frame number={25} section="Product Tour">
      <SectionTitle eyebrow="DASHBOARD" title="Dashboard: Momentum" subtitle="Velocity of orders and dispatch." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Daily dispatch velocity</Bullet>
          <Bullet>Order intake trends</Bullet>
          <Bullet>Run-rate vs target trajectory</Bullet>
          <Bullet>Intra-month performance pacing</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col justify-end relative overflow-hidden">
          <div className="thin-label absolute top-[2vw] left-[2vw]">VELOCITY TREND</div>
          <div className="flex items-end gap-[.5vw] h-[25vh] opacity-80">
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '35%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '42%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '38%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '45%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '52%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '48%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '58%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '62%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '55%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '68%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '72%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '65%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '75%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '82%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '85%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '80%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '88%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '92%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '95%' }} />
            <div className="flex-1 bg-[linear-gradient(0deg,#1389e8,transparent)] rounded-t" style={{ height: '100%' }} />
          </div>
        </div>
      </div>
    </Frame>
  );
}

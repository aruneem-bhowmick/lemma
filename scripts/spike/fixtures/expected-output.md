# Graph Theory — Eulerian & Hamiltonian Paths

## Eulerian Circuits

> [!definition] Eulerian Circuit
> A **closed walk** in a graph $G = (V, E)$ that traverses every edge in $E$ exactly once.
> Sometimes called an *Euler tour*. A graph admitting one is called *Eulerian*.

> [!theorem] Euler's Theorem (Eulerian Circuit Characterisation)
> A connected graph $G$ has an Eulerian circuit if and only if every vertex has even degree.

> [!proof]
> $(\Rightarrow)$ Suppose $G$ has an Eulerian circuit $C$. Each time $C$ visits a vertex $v$,
> it uses one edge to enter and one distinct edge to leave, contributing $2$ to $\deg(v)$.
> Hence $\deg(v)$ is even for all $v \in V$.
>
> $(\Leftarrow)$ Suppose every vertex has even degree. Start at any vertex $u$ and follow
> edges (without repetition) until forced to stop. Because every degree is even, the only
> vertex where a trail can get stuck is $u$ itself — so we obtain a closed trail $T$.
> If $T$ covers all edges, we are done. Otherwise, since $G$ is connected, $T$ shares a
> vertex $w$ with an uncovered edge. The uncovered subgraph also has all even degrees
> (the circuit used pairs of edges at each vertex). Apply induction on $|E|$ to find a
> circuit through $w$ in the residual graph, then splice it into $T$ at $w$. Repeat until
> all edges are covered.

$$
G \text{ is Eulerian} \iff \deg(v) \equiv 0 \pmod{2} \quad \forall v \in V(G)
$$

## Example Graph — $C_4$ with One Diagonal

> [!diagram] $C_4$ with one diagonal
> ![fig](./assets/<asset-placeholder>.png)
> ```json
> {
>   "type": "undirected",
>   "vertices": ["a", "b", "c", "d"],
>   "edges": [["a","b"],["b","c"],["c","d"],["d","a"],["a","c"]],
>   "caption": "C4 with one diagonal"
> }
> ```
>
> Vertex degrees: $\deg(a)=3$, $\deg(b)=2$, $\deg(c)=3$, $\deg(d)=2$.
> Because $a$ and $c$ have odd degree, this graph is **not** Eulerian.

## Eulerian Path (Non-Closed)

> [!definition] Eulerian Path
> A walk that traverses every edge exactly once but need not return to its start vertex.

> [!theorem] Eulerian Path Condition
> A connected graph $G$ has an Eulerian path (but not circuit) if and only if
> it has **exactly two vertices of odd degree**. The path starts at one odd-degree
> vertex and ends at the other.

## Hamiltonian Paths

> [!definition] Hamiltonian Path
> A path in $G$ that visits every **vertex** exactly once.
> If it also returns to the start, it is a *Hamiltonian circuit*.

<!-- confidence: high -->
